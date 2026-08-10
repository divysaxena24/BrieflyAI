/**
 * Engine API resources (Phase 5J STEP 4).
 *
 * `EngineApi` is the seam between the HTTP routes and the application
 * engines: every resource operation is a thin, typed wrapper over
 * `ApplicationEngines` (+ `PersistenceEngine` for the persistence
 * operations). Routes call the singleton through `getEngineApi()`; tests
 * inject fresh engines and stores.
 *
 * The class deliberately reimplements no engine logic — every method
 * delegates to the existing engines/managers (successor construction and
 * graph rebuild happen inside `ApplicationEngines`). Timestamps are
 * caller-supplied through the injected clock `now`, so the layer stays
 * deterministic in tests.
 *
 * The wire→model conversion helpers (`toWorkflowAction`, `workflowFromWire`,
 * `triggerEventFromWire`) are the only place the validated HTTP bodies are
 * interpreted; the model creators remain the authoritative validators
 * (`createWorkflow` validates steps/cycles, etc.).
 *
 * Route files (`app/api/*`) are the only modules allowed to import the
 * Next.js/supabase plumbing (`./auth`); they stay thin adapters over these
 * resources.
 */

import { AppError, ValidationError } from "@/lib/errors";
import {
  createAction,
  type Action,
  type CreateActionInput,
} from "@/lib/actions/types";
import type { PlanActionRequest, PlanIntent } from "@/lib/actions/planner";
import {
  createWorkflow,
  createWorkflowStep,
  type CreateWorkflowInput,
  type Workflow,
  type WorkflowAction,
  type WorkflowCondition,
  type WorkflowPriority,
  type WorkflowTrigger,
  type WorkflowTriggerKind,
} from "@/lib/workflows/types";
import type { WorkflowTriggerEvent } from "@/lib/workflows/triggers";
import type { ExecuteWorkflowOptions, PlanWorkflowOptions } from "@/lib/workflows/production";
import type { CreateMemoryInput, Memory } from "@/lib/memory/types";
import type { MemoryPatch } from "@/lib/memory/repository";
import type {
  Conversation,
  ConversationMessage,
  CreateConversationInput,
  CreateMessageInput,
} from "@/lib/conversation/types";
import type { CreateJobInput, Job, JobSchedule } from "@/lib/jobs/types";
import type { Digest, DigestKind, DigestTemplate } from "@/lib/digest/types";
import type { BuildDigestOptions } from "@/lib/digest/production";
import type { ExecutionPlan } from "@/lib/tools/plan";
import {
  getProductionPersistence,
  type PersistenceEngine,
} from "@/lib/persistence/production";
import { ApplicationEngines, getApplicationEngines } from "./engines";

/** 404 raised by the resource layer for missing engine entities. */
export class ResourceNotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} "${id}" not found`, 404, "not_found", { resource, id });
  }
}

/** Options accepted by the {@link EngineApi} constructor. */
export interface EngineApiOptions {
  readonly engines?: ApplicationEngines;
  readonly persistence?: PersistenceEngine;
  /** Injected current-time source; defaults to the wall clock. */
  readonly now?: () => string;
}

/** The wire shape of a workflow step action (see `toWorkflowAction`). */
export type WireWorkflowAction =
  | {
      readonly kind: "action";
      readonly intent?: string;
      readonly requests?: readonly PlanActionRequest[];
    }
  | { readonly kind: "job"; readonly jobId: string }
  | { readonly kind: "tool"; readonly plan: Readonly<Record<string, unknown>> }
  | {
      readonly kind: "digest";
      readonly template?: Readonly<Record<string, unknown>>;
      readonly query?: string;
    };

/** The wire shape of a workflow trigger (kind defaults to `"manual"`). */
export interface WireWorkflowTrigger {
  readonly kind?: WorkflowTriggerKind;
  readonly event?: string;
  readonly schedule?: JobSchedule;
  readonly conversationId?: string;
  readonly memoryId?: string;
  readonly digestId?: string;
  readonly jobId?: string;
  readonly actionId?: string;
  readonly toolId?: string;
}

/** The wire shape of a workflow step. */
export interface WireWorkflowStep {
  readonly id: string;
  readonly name: string;
  readonly action: WireWorkflowAction;
  readonly dependsOn?: readonly string[];
  readonly priority?: WorkflowPriority;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly condition?: WorkflowCondition;
}

/** The wire shape of a workflow registration body. */
export interface WireWorkflow {
  readonly id?: string;
  readonly name: string;
  readonly description?: string;
  readonly priority?: WorkflowPriority;
  readonly trigger?: WireWorkflowTrigger;
  readonly steps: readonly WireWorkflowStep[];
  readonly maxAttempts?: number;
  readonly createdAt: string;
  readonly scheduledAt?: string;
  readonly enabled?: boolean;
}

/**
 * Interpret a validated wire step action into a model `WorkflowAction`.
 *
 * The discriminated union guarantees `kind`; the remaining fields are
 * guarded at runtime. `plan`/`template` cross the wire as generic objects
 * and are cast after the kind guard — the model layers deep-freeze their
 * own values, so the cast is safe at this single boundary.
 */
export function toWorkflowAction(action: WireWorkflowAction): WorkflowAction {
  switch (action.kind) {
    case "action":
      return {
        kind: "action",
        ...(action.intent !== undefined ? { intent: action.intent } : {}),
        ...(action.requests !== undefined ? { requests: [...action.requests] } : {}),
      };
    case "job":
      return { kind: "job", jobId: action.jobId };
    case "tool":
      return { kind: "tool", plan: action.plan as unknown as ExecutionPlan };
    case "digest":
      return {
        kind: "digest",
        ...(action.template !== undefined
          ? { template: action.template as unknown as DigestTemplate }
          : {}),
        ...(action.query !== undefined ? { query: action.query } : {}),
      };
  }
}

/**
 * Convert a validated workflow wire body into a `CreateWorkflowInput`.
 * Pure — the steps are rebuilt via `createWorkflowStep`; the model's
 * `createWorkflow` remains the authoritative validator.
 */
export function workflowFromWire(wire: WireWorkflow): CreateWorkflowInput {
  return {
    ...(wire.id !== undefined ? { id: wire.id } : {}),
    name: wire.name,
    ...(wire.description !== undefined ? { description: wire.description } : {}),
    ...(wire.priority !== undefined ? { priority: wire.priority } : {}),
    ...(wire.trigger !== undefined ? { trigger: wireTriggerFromWire(wire.trigger) } : {}),
    steps: wire.steps.map((step) =>
      createWorkflowStep({
        id: step.id,
        name: step.name,
        action: toWorkflowAction(step.action),
        ...(step.dependsOn !== undefined ? { dependsOn: step.dependsOn } : {}),
        ...(step.priority !== undefined ? { priority: step.priority } : {}),
        ...(step.maxAttempts !== undefined ? { maxAttempts: step.maxAttempts } : {}),
        ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
        ...(step.condition !== undefined ? { condition: step.condition } : {}),
      }),
    ),
    ...(wire.maxAttempts !== undefined ? { maxAttempts: wire.maxAttempts } : {}),
    createdAt: wire.createdAt,
    ...(wire.scheduledAt !== undefined ? { scheduledAt: wire.scheduledAt } : {}),
    ...(wire.enabled !== undefined ? { enabled: wire.enabled } : {}),
  };
}

/**
 * Convert a wire trigger into a model `WorkflowTrigger`, defaulting the kind
 * to `"manual"` (mirrors `createWorkflow`).
 */
function wireTriggerFromWire(trigger: WireWorkflowTrigger): WorkflowTrigger {
  return {
    kind: trigger.kind ?? "manual",
    ...(trigger.event !== undefined ? { event: trigger.event } : {}),
    ...(trigger.schedule !== undefined ? { schedule: trigger.schedule } : {}),
    ...(trigger.conversationId !== undefined ? { conversationId: trigger.conversationId } : {}),
    ...(trigger.memoryId !== undefined ? { memoryId: trigger.memoryId } : {}),
    ...(trigger.digestId !== undefined ? { digestId: trigger.digestId } : {}),
    ...(trigger.jobId !== undefined ? { jobId: trigger.jobId } : {}),
    ...(trigger.actionId !== undefined ? { actionId: trigger.actionId } : {}),
    ...(trigger.toolId !== undefined ? { toolId: trigger.toolId } : {}),
  };
}

/** The wire shape of a trigger-event body. */
export interface WireTriggerEvent {
  readonly kind: WorkflowTriggerKind;
  readonly entityId?: string;
  readonly event?: string;
  readonly now: string;
  readonly signal?: Readonly<Record<string, unknown>>;
}

/**
 * Convert a validated trigger-event wire body into a `WorkflowTriggerEvent`,
 * mapping `entityId` to the kind-specific id field.
 */
export function triggerEventFromWire(wire: WireTriggerEvent): WorkflowTriggerEvent {
  const base: WorkflowTriggerEvent = {
    kind: wire.kind,
    now: wire.now,
    ...(wire.event !== undefined ? { event: wire.event } : {}),
    ...(wire.signal !== undefined ? { signal: wire.signal } : {}),
  };
  switch (wire.kind) {
    case "conversation":
      return { ...base, ...(wire.entityId !== undefined ? { conversationId: wire.entityId } : {}) };
    case "memory":
      return { ...base, ...(wire.entityId !== undefined ? { memoryId: wire.entityId } : {}) };
    case "digest":
      return { ...base, ...(wire.entityId !== undefined ? { digestId: wire.entityId } : {}) };
    case "job":
      return { ...base, ...(wire.entityId !== undefined ? { jobId: wire.entityId } : {}) };
    case "action":
      return { ...base, ...(wire.entityId !== undefined ? { actionId: wire.entityId } : {}) };
    case "tool":
      return { ...base, ...(wire.entityId !== undefined ? { toolId: wire.entityId } : {}) };
    default:
      return base;
  }
}

/**
 * The engine resource facade over `ApplicationEngines` + `PersistenceEngine`.
 *
 * Stateful by design (it is the application wiring): mutations flow through
 * `ApplicationEngines`, which applies successors and rebuilds the composition
 * graph. The underlying models/repositories/managers remain immutable and
 * deterministic.
 */
export class EngineApi {
  readonly engines: ApplicationEngines;
  readonly persistence: PersistenceEngine;

  private readonly now: () => string;

  constructor(options: EngineApiOptions = {}) {
    this.engines = options.engines ?? getApplicationEngines();
    this.persistence = options.persistence ?? getProductionPersistence();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // ─────────────────────────────────────────────────────────────
  // Memories
  // ─────────────────────────────────────────────────────────────

  listMemories(): Memory[] {
    return this.engines.listMemories();
  }

  getMemory(id: string): Memory {
    return this.requireFound("memory", id, this.engines.findMemory(id));
  }

  createMemory(input: CreateMemoryInput): Memory {
    return this.engines.createMemory(input);
  }

  bulkCreateMemories(inputs: readonly CreateMemoryInput[]): Memory[] {
    return this.engines.bulkCreateMemories(inputs);
  }

  updateMemory(id: string, changes: MemoryPatch): Memory {
    return this.engines.updateMemory(id, changes);
  }

  archiveMemory(id: string): Memory {
    this.engines.archiveMemory(id);
    return this.getMemory(id);
  }

  restoreMemory(id: string): Memory {
    this.engines.restoreMemory(id);
    return this.getMemory(id);
  }

  deleteMemory(id: string): void {
    this.engines.deleteMemory(id);
  }

  // ─────────────────────────────────────────────────────────────
  // Conversations
  // ─────────────────────────────────────────────────────────────

  listConversations(): Conversation[] {
    return this.engines.listConversations();
  }

  getConversation(id: string): Conversation {
    return this.requireFound("conversation", id, this.engines.getConversation(id));
  }

  startConversation(input: CreateConversationInput): Conversation {
    return this.engines.startConversation(input);
  }

  appendMessage(id: string, input: CreateMessageInput): ConversationMessage {
    return this.engines.appendMessage(id, input);
  }

  renameConversation(id: string, title: string): Conversation {
    this.engines.renameConversation(id, title);
    return this.getConversation(id);
  }

  archiveConversation(id: string): Conversation {
    this.engines.archiveConversation(id);
    return this.getConversation(id);
  }

  restoreConversation(id: string): Conversation {
    this.engines.restoreConversation(id);
    return this.getConversation(id);
  }

  closeConversation(id: string): Conversation {
    this.engines.closeConversation(id);
    return this.getConversation(id);
  }

  deleteConversation(id: string): void {
    this.engines.deleteConversation(id);
  }

  // ─────────────────────────────────────────────────────────────
  // Digests
  // ─────────────────────────────────────────────────────────────

  listDigests(): readonly Digest[] {
    return this.engines.listDigests();
  }

  getDigest(id: string): Digest {
    return this.requireFound("digest", id, this.engines.findDigest(id));
  }

  buildDigest(kind: DigestKind, options: BuildDigestOptions): Promise<Digest> {
    switch (kind) {
      case "morning":
        return this.engines.digest.buildMorningDigest(options);
      case "evening":
        return this.engines.digest.buildEveningDigest(options);
      case "weekly":
        return this.engines.digest.buildWeeklyDigest(options);
      default:
        return Promise.reject(new ValidationError(`Unsupported digest kind "${kind}"`));
    }
  }

  publishDigest(id: string, at?: string): Digest {
    this.engines.publishDigest(id, at ?? this.now());
    return this.getDigest(id);
  }

  markDigestRead(id: string, at?: string): Digest {
    this.engines.markDigestRead(id, at ?? this.now());
    return this.getDigest(id);
  }

  markDigestUnread(id: string, at?: string): Digest {
    this.engines.markDigestUnread(id, at ?? this.now());
    return this.getDigest(id);
  }

  archiveDigest(id: string, at?: string): Digest {
    this.engines.archiveDigest(id, at ?? this.now());
    return this.getDigest(id);
  }

  restoreDigest(id: string, at?: string): Digest {
    this.engines.restoreDigest(id, at ?? this.now());
    return this.getDigest(id);
  }

  deleteDigest(id: string, at?: string): void {
    this.engines.deleteDigest(id, at ?? this.now());
  }

  // ─────────────────────────────────────────────────────────────
  // Jobs
  // ─────────────────────────────────────────────────────────────

  listJobs(): readonly Job[] {
    return this.engines.listJobs();
  }

  getJob(id: string): Job {
    return this.requireFound("job", id, this.engines.findJob(id));
  }

  registerJob(input: CreateJobInput): Job {
    return this.engines.registerJob(input);
  }

  runJob(id: string, at?: string): ReturnType<ApplicationEngines["runJob"]> {
    return this.engines.runJob(id, at ?? this.now());
  }

  runScheduledJobs(at?: string): ReturnType<ApplicationEngines["runScheduledJobs"]> {
    return this.engines.runScheduledJobs(at ?? this.now());
  }

  cancelJob(id: string, at?: string): Job {
    this.engines.cancelJob(id, at ?? this.now());
    return this.getJob(id);
  }

  retryJob(id: string): Job {
    this.engines.retryJob(id);
    return this.getJob(id);
  }

  archiveJob(id: string): Job {
    this.engines.archiveJob(id);
    return this.getJob(id);
  }

  restoreJob(id: string): Job {
    this.engines.restoreJob(id);
    return this.getJob(id);
  }

  unregisterJob(id: string): void {
    this.engines.unregisterJob(id);
  }

  // ─────────────────────────────────────────────────────────────
  // Actions
  // ─────────────────────────────────────────────────────────────

  listActions(): readonly Action[] {
    return this.engines.listActions();
  }

  getAction(id: string): Action {
    return this.requireFound("action", id, this.engines.findAction(id));
  }

  plan(intent: PlanIntent): ReturnType<ApplicationEngines["plan"]> {
    return this.engines.plan(intent);
  }

  executePlan(
    plan: Parameters<ApplicationEngines["executePlan"]>[0],
    options?: Parameters<ApplicationEngines["executePlan"]>[1],
  ): ReturnType<ApplicationEngines["executePlan"]> {
    return this.engines.executePlan(plan, options);
  }

  executeActions(
    actions: Parameters<ApplicationEngines["executeActions"]>[0],
    options?: Parameters<ApplicationEngines["executeActions"]>[1],
  ): ReturnType<ApplicationEngines["executeActions"]> {
    return this.engines.executeActions(actions, options);
  }

  runAction(input: CreateActionInput): ReturnType<ApplicationEngines["runAction"]> {
    return this.engines.runAction(createAction(input));
  }

  cancelAction(id: string, at?: string): Action {
    this.engines.cancelAction(id, at ?? this.now());
    return this.getAction(id);
  }

  retryAction(id: string): Action {
    this.engines.retryAction(id);
    return this.getAction(id);
  }

  archiveAction(id: string): Action {
    this.engines.archiveAction(id);
    return this.getAction(id);
  }

  restoreAction(id: string): Action {
    this.engines.restoreAction(id);
    return this.getAction(id);
  }

  deleteAction(id: string): void {
    this.engines.deleteAction(id);
  }

  // ─────────────────────────────────────────────────────────────
  // Workflows
  // ─────────────────────────────────────────────────────────────

  listWorkflows(): readonly Workflow[] {
    return this.engines.listWorkflows();
  }

  getWorkflow(id: string): Workflow {
    return this.requireFound("workflow", id, this.engines.findWorkflow(id));
  }

  registerWorkflow(input: CreateWorkflowInput): Workflow {
    const workflow = createWorkflow(input);
    const registered = this.engines.registerWorkflow(workflow);
    if (registered === undefined) {
      throw new ResourceNotFoundError("workflow", workflow.id);
    }
    return registered;
  }

  planWorkflow(
    workflow: Workflow,
    options: PlanWorkflowOptions,
  ): ReturnType<ApplicationEngines["planWorkflow"]> {
    return this.engines.planWorkflow(workflow, options);
  }

  runWorkflow(
    workflow: Workflow,
    options?: ExecuteWorkflowOptions,
  ): ReturnType<ApplicationEngines["runWorkflow"]> {
    return this.engines.runWorkflow(workflow, options);
  }

  runWorkflowById(
    id: string,
    options?: ExecuteWorkflowOptions,
  ): ReturnType<ApplicationEngines["runWorkflow"]> {
    return this.engines.runWorkflow(this.getWorkflow(id), options);
  }

  triggerWorkflow(
    event: WorkflowTriggerEvent,
    options?: ExecuteWorkflowOptions,
  ): ReturnType<ApplicationEngines["triggerWorkflow"]> {
    return this.engines.triggerWorkflow(event, options);
  }

  disableWorkflow(id: string): Workflow {
    this.engines.disableWorkflow(id);
    return this.getWorkflow(id);
  }

  enableWorkflow(id: string): Workflow {
    this.engines.enableWorkflow(id);
    return this.getWorkflow(id);
  }

  archiveWorkflow(id: string): Workflow {
    this.engines.archiveWorkflow(id);
    return this.getWorkflow(id);
  }

  restoreWorkflow(id: string): Workflow {
    this.engines.restoreWorkflow(id);
    return this.getWorkflow(id);
  }

  deleteWorkflow(id: string): void {
    this.engines.deleteWorkflow(id);
  }

  // ─────────────────────────────────────────────────────────────
  // Persistence (scoped per application user)
  // ─────────────────────────────────────────────────────────────

  /** Persist every engine's collection under `scope` (failure-isolated). */
  saveAll(scope: string): ReturnType<PersistenceEngine["saveAll"]> {
    return this.persistence.saveAll(scope, this.engines.engines());
  }

  /**
   * Restore every engine from the persisted collections under `scope`
   * (restart recovery). Missing collections restore as empty engines;
   * per-collection load failures are isolated and reported.
   */
  async loadAll(scope: string): Promise<{ errors: readonly unknown[] }> {
    const { engines, errors } = await this.persistence.restoreAll(scope);
    this.engines.replaceAll(engines);
    return { errors };
  }

  /** Clear every persisted collection under `scope`. Never throws. */
  clearAll(scope: string): Promise<void> {
    return this.persistence.clearAll(scope);
  }

  /** Current engine collection sizes (state overview for GET). */
  stateOverview(): {
    readonly memory: number;
    readonly conversation: number;
    readonly job: number;
    readonly digest: number;
    readonly action: number;
    readonly workflow: number;
  } {
    return {
      memory: this.engines.listMemories().length,
      conversation: this.engines.listConversations().length,
      job: this.engines.listJobs().length,
      digest: this.engines.listDigests().length,
      action: this.engines.listActions().length,
      workflow: this.engines.listWorkflows().length,
    };
  }

  /** Throw `ResourceNotFoundError` when `value` is `undefined`. */
  private requireFound<T>(resource: string, id: string, value: T | undefined): T {
    if (value === undefined) throw new ResourceNotFoundError(resource, id);
    return value;
  }
}

/**
 * Resolve the `{ id }` path parameter from a dynamic-route context.
 *
 * Next.js passes the route context as the handler's second argument; in App
 * Router 15+ `params` is a `Promise`. The context is deliberately typed
 * `unknown` so handlers stay assignable to the project's `RouteHandler`
 * shape. Throws `ValidationError` (400) when the parameter is absent.
 */
export async function routeId(context: unknown): Promise<string> {
  if (context === null || typeof context !== "object" || !("params" in context)) {
    throw new ValidationError("Missing route parameters");
  }
  const params = (context as { params: Promise<{ id: string }> | { id: string } }).params;
  const resolved = await params;
  if (resolved === null || typeof resolved?.id !== "string" || resolved.id.length === 0) {
    throw new ValidationError("Missing route id parameter");
  }
  return resolved.id;
}

/**
 * Build a fresh engine API root.
 *
 * Options seed the graph (dependency injection). By default the resources
 * operate on the application's single engines/persistence roots.
 */
export function createEngineApi(options: EngineApiOptions = {}): EngineApi {
  return new EngineApi(options);
}

/** The application's single engine API root (module-level singleton). */
const productionEngineApi = createEngineApi();

/** Return the application's single engine API root instance. */
export function getEngineApi(): EngineApi {
  return productionEngineApi;
}
