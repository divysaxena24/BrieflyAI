/**
 * Engine API — application engines (Phase 5J STEP 4).
 *
 * `ApplicationEngines` is the application-level composition root the API
 * routes operate on. It holds the six production engines and keeps their
 * dependency graph consistent across every mutation:
 *
 * - **Successor-applied engines** (memory, conversation) return successor
 *   engines on mutation; `ApplicationEngines` applies them.
 * - **Composition-root engines** (digest, jobs, actions, workflows) mutate
 *   their own managers internally through their public APIs; manager-level
 *   operations (cancel/archive/publish/...) are applied by rebuilding the
 *   root over the successor manager.
 * - **Rebuild**: after every mutation the four composition roots are
 *   reconstructed bottom-up (digest → jobs → actions → workflows) so each
 *   root always holds the current sibling engines and managers.
 *
 * The layer is seeded from the production singletons by default and exposes
 * `getApplicationEngines()`. It is the "never instantiate engines inside
 * routes" seam: routes call `getApplicationEngines()` and the resource
 * functions in `./resources`.
 *
 * Application wiring note: the digest engine's data sources are the *app*
 * engines (not the module singletons), so digests aggregate the app state —
 * this is the application-level equivalent of `createProductionDigestSources`
 * (which is hardwired to the singletons and cannot be reused here without
 * modifying a previous phase).
 *
 * Reconciliation scope: the four composition roots hold the *same app-level
 * engine instances* (the Action Engine is built over the app Digest/Job
 * engines; the Workflow Engine over the app Action/Job/Digest engines), so
 * state advanced inside a root — digests built, jobs settled, actions
 * executed, workflows settled — is already visible on the app roots' own
 * managers. Only the successor-applied engines (memory, conversation) can
 * diverge inside the roots (each root applies its own successors), so
 * `reconcile()` merges those back after every execution path that can write
 * to them; the shared-instance invariant keeps the other four in sync.
 */

import { ContextEngine } from "@/lib/context/engine";
import { getProductionContextEngine } from "@/lib/context/production";
import { ToolExecutor } from "@/lib/tools/executor";
import { ToolRegistry } from "@/lib/tools/registry";
import { createBuiltInReadTools } from "@/lib/tools/builtin";
import {
  DIGEST_CONTEXT_TOKEN_BUDGET,
  DIGEST_TOOL_TIMEOUT_MS,
  DigestEngine,
} from "@/lib/digest/production";
import type { DigestDataSources } from "@/lib/digest/builder";
import { JobEngine, type JobEngineOptions } from "@/lib/jobs/production";
import { ActionEngine } from "@/lib/actions/production";
import { WorkflowEngine } from "@/lib/workflows/production";
import {
  ConversationEngine,
  createProductionConversationEngine,
  getProductionConversationEngine,
} from "@/lib/conversation/production";
import {
  MemoryEngine,
  createProductionMemoryEngine,
  getProductionMemoryEngine,
} from "@/lib/memory/production";
import { MemoryRepository } from "@/lib/memory/repository";
import { ConversationRepository } from "@/lib/conversation/repository";
import type { CreateMemoryInput, Memory } from "@/lib/memory/types";
import type { Conversation } from "@/lib/conversation/types";
import type { DigestManager } from "@/lib/digest/manager";
import type { JobManager } from "@/lib/jobs/manager";
import type { ActionManager } from "@/lib/actions/manager";
import { WorkflowManager } from "@/lib/workflows/manager";
import type { EngineSet } from "@/lib/persistence/production";

/** Options accepted by the {@link ApplicationEngines} constructor. */
export interface ApplicationEnginesOptions {
  readonly memory?: MemoryEngine;
  readonly conversation?: ConversationEngine;
  readonly digest?: DigestEngine;
  readonly jobs?: JobEngine;
  readonly actions?: ActionEngine;
  readonly workflows?: WorkflowEngine;
  readonly context?: ContextEngine;
  /** Injected current-time source; defaults to the wall clock. */
  readonly now?: () => string;
}

/**
 * The application-level engine composition root.
 *
 * Stateful by design (it is the application wiring): the six engines are
 * replaced via successor construction/rebuild on every mutation; the
 * underlying models/repositories/managers remain immutable and
 * deterministic.
 */
export class ApplicationEngines {
  private _memory: MemoryEngine;
  private _conversation: ConversationEngine;
  private _digest: DigestEngine;
  private _jobs: JobEngine;
  private _actions: ActionEngine;
  private _workflows: WorkflowEngine;

  /** The Context Engine shared by every composition root (never replaced). */
  readonly context: ContextEngine;

  /**
   * The tool executor backing the digest sources. Stateless with respect to
   * the engines (it executes plans through its registry), so it is built once
   * and reused across every graph rebuild.
   */
  private readonly digestToolExecutor: ToolExecutor;

  private readonly now: () => string;

  constructor(options: ApplicationEnginesOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.context = options.context ?? getProductionContextEngine();
    this.digestToolExecutor = new ToolExecutor(new ToolRegistry(createBuiltInReadTools()));
    this._memory = options.memory ?? getProductionMemoryEngine();
    this._conversation = options.conversation ?? getProductionConversationEngine();

    // Composition roots are rebuilt bottom-up on every mutation. When not
    // injected they are seeded fresh over the app engines — never from the
    // module singletons, whose managers carry process-wide state and would
    // leak into (and be polluted by) this application root.
    this._digest =
      options.digest ?? new DigestEngine({ sources: this.appDigestSources(), now: this.now });
    this._jobs =
      options.jobs ??
      new JobEngine({
        memoryEngine: this._memory,
        conversationEngine: this._conversation,
        contextEngine: this.context,
        seedDigestJob: false,
        now: this.now,
      });
    this._actions =
      options.actions ??
      new ActionEngine({
        memoryEngine: this._memory,
        conversationEngine: this._conversation,
        digestEngine: this._digest,
        jobEngine: this._jobs,
        contextEngine: this.context,
        now: this.now,
      });
    this._workflows =
      options.workflows ??
      new WorkflowEngine({
        actionEngine: this._actions,
        jobEngine: this._jobs,
        digestEngine: this._digest,
        contextEngine: this.context,
        now: this.now,
      });
    this.rebuild();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Engine accessors (readonly views; never replaced in place).
  // ─────────────────────────────────────────────────────────────────────

  get memory(): MemoryEngine {
    return this._memory;
  }
  get conversation(): ConversationEngine {
    return this._conversation;
  }
  get digest(): DigestEngine {
    return this._digest;
  }
  get jobs(): JobEngine {
    return this._jobs;
  }
  get actions(): ActionEngine {
    return this._actions;
  }
  get workflows(): WorkflowEngine {
    return this._workflows;
  }

  /** The current engine set (for persistence `saveAll`). */
  engines(): EngineSet {
    return {
      memory: this._memory,
      conversation: this._conversation,
      jobs: this._jobs,
      digest: this._digest,
      actions: this._actions,
      workflows: this._workflows,
    };
  }

  /** Swap all six engines (persistence restore) and re-wire the graph. */
  replaceAll(set: EngineSet): void {
    this._memory = set.memory;
    this._conversation = set.conversation;
    this._digest = set.digest;
    this._jobs = set.jobs;
    this._actions = set.actions;
    this._workflows = set.workflows;
    this.rebuild();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Memory operations (successor-applied).
  // ─────────────────────────────────────────────────────────────────────

  listMemories() {
    return this._memory.listMemories();
  }

  findMemory(id: string) {
    return this._memory.getMemory(id);
  }

  createMemory(input: Parameters<MemoryEngine["remember"]>[0]): ReturnType<MemoryEngine["remember"]>["memory"] {
    const { engine, memory } = this._memory.remember(input);
    this._memory = engine;
    this.rebuild();
    return memory;
  }

  bulkCreateMemories(inputs: readonly CreateMemoryInput[]): Memory[] {
    const { engine, added } = this._memory.bulkRemember(inputs);
    this._memory = engine;
    this.rebuild();
    return added;
  }

  updateMemory(id: string, changes: Parameters<MemoryEngine["updateMemory"]>[1]) {
    const { engine, memory } = this._memory.updateMemory(id, changes);
    this._memory = engine;
    this.rebuild();
    return memory;
  }

  deleteMemory(id: string): void {
    this._memory = this._memory.deleteMemory(id);
    this.rebuild();
  }

  archiveMemory(id: string): void {
    this._memory = this._memory.archiveMemory(id);
    this.rebuild();
  }

  restoreMemory(id: string): void {
    this._memory = this._memory.restoreMemory(id);
    this.rebuild();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Conversation operations (successor-applied).
  // ─────────────────────────────────────────────────────────────────────

  listConversations() {
    return this._conversation.listConversations();
  }

  getConversation(id: string) {
    return this._conversation.getConversation(id);
  }

  startConversation(input: Parameters<ConversationEngine["startConversation"]>[0]) {
    const { engine, conversation } = this._conversation.startConversation(input);
    this._conversation = engine;
    this.rebuild();
    return conversation;
  }

  appendMessage(conversationId: string, input: Parameters<ConversationEngine["appendMessage"]>[1]) {
    const { engine, message } = this._conversation.appendMessage(conversationId, input);
    this._conversation = engine;
    this.rebuild();
    return message;
  }

  renameConversation(id: string, title: string): void {
    this._conversation = this._conversation.renameConversation(id, title);
    this.rebuild();
  }

  archiveConversation(id: string): void {
    this._conversation = this._conversation.archiveConversation(id);
    this.rebuild();
  }

  restoreConversation(id: string): void {
    this._conversation = this._conversation.restoreConversation(id);
    this.rebuild();
  }

  closeConversation(id: string): void {
    this._conversation = this._conversation.closeConversation(id);
    this.rebuild();
  }

  deleteConversation(id: string): void {
    this._conversation = this._conversation.deleteConversation(id);
    this.rebuild();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Digest operations (composition-root).
  // ─────────────────────────────────────────────────────────────────────

  listDigests() {
    return this._digest.manager.list();
  }

  findDigest(id: string) {
    return this._digest.findDigest(id);
  }

  buildDigest(
    template: Parameters<DigestEngine["build"]>[0],
    options: Parameters<DigestEngine["build"]>[1],
  ): ReturnType<DigestEngine["build"]> {
    return this._digest.build(template, options);
  }

  /** Apply a manager-level digest operation and rebuild the graph. */
  private withDigestManager(apply: (manager: DigestManager) => { manager: DigestManager }): void {
    const { manager } = apply(this._digest.manager);
    this.setDigestManager(manager);
    this.rebuild();
  }

  publishDigest(id: string, at: string): void {
    this.withDigestManager((manager) => manager.publishDigest(id, at));
  }

  markDigestRead(id: string, at: string): void {
    this.withDigestManager((manager) => manager.markRead(id, at));
  }

  markDigestUnread(id: string, at: string): void {
    this.withDigestManager((manager) => manager.markUnread(id, at));
  }

  archiveDigest(id: string, at: string): void {
    this.withDigestManager((manager) => manager.archiveDigest(id, at));
  }

  restoreDigest(id: string, at: string): void {
    this.withDigestManager((manager) => manager.restoreDigest(id, at));
  }

  deleteDigest(id: string, at: string): void {
    this.withDigestManager((manager) => manager.deleteDigest(id, at));
  }

  // ─────────────────────────────────────────────────────────────────────
  // Job operations (composition-root).
  // ─────────────────────────────────────────────────────────────────────

  listJobs() {
    return this._jobs.manager.list();
  }

  findJob(id: string) {
    return this._jobs.manager.find(id);
  }

  registerJob(input: Parameters<JobManager["registerJob"]>[0]) {
    const { manager, job } = this._jobs.manager.registerJob(input);
    this.setJobManager(manager);
    this.rebuild();
    return job;
  }

  async runJob(jobId: string, at?: string, signal?: AbortSignal) {
    const summary = await this._jobs.runManual(jobId, at, signal);
    this.reconcile();
    return summary;
  }

  async runScheduledJobs(at?: string, signal?: AbortSignal) {
    const summary = await this._jobs.runScheduled(at, signal);
    this.reconcile();
    return summary;
  }

  /** Apply a manager-level job operation and rebuild the graph. */
  private withJobManager(apply: (manager: JobManager) => { manager: JobManager }): void {
    const { manager } = apply(this._jobs.manager);
    this.setJobManager(manager);
    this.rebuild();
  }

  cancelJob(id: string, at: string): void {
    this.withJobManager((manager) => manager.cancelJob(id, { at }));
  }

  retryJob(id: string): void {
    this.withJobManager((manager) => manager.retryJob(id));
  }

  archiveJob(id: string): void {
    this.withJobManager((manager) => ({ manager: manager.archiveJob(id) }));
  }

  restoreJob(id: string): void {
    this.withJobManager((manager) => ({ manager: manager.restoreJob(id) }));
  }

  unregisterJob(id: string): void {
    this.withJobManager((manager) => ({ manager: manager.unregisterJob(id) }));
  }

  // ─────────────────────────────────────────────────────────────────────
  // Action operations (composition-root).
  // ─────────────────────────────────────────────────────────────────────

  listActions() {
    return this._actions.manager.list();
  }

  findAction(id: string) {
    return this._actions.findAction(id);
  }

  plan(intent: Parameters<ActionEngine["plan"]>[0]) {
    return this._actions.plan(intent);
  }

  async executePlan(plan: Parameters<ActionEngine["executePlan"]>[0], options?: Parameters<ActionEngine["executePlan"]>[1]) {
    const result = await this._actions.executePlan(plan, options);
    this.reconcile();
    return result;
  }

  async executeActions(actions: Parameters<ActionEngine["executeActions"]>[0], options?: Parameters<ActionEngine["executeActions"]>[1]) {
    const result = await this._actions.executeActions(actions, options);
    this.reconcile();
    return result;
  }

  async runAction(action: Parameters<ActionEngine["runAction"]>[0], options?: Parameters<ActionEngine["runAction"]>[1]) {
    const result = await this._actions.runAction(action, options);
    this.reconcile();
    return result;
  }

  /** Apply a manager-level action operation and rebuild the graph. */
  private withActionManager(apply: (manager: ActionManager) => { manager: ActionManager }): void {
    const { manager } = apply(this._actions.manager);
    this.setActionManager(manager);
    this.rebuild();
  }

  cancelAction(id: string, at: string): void {
    this.withActionManager((manager) => manager.cancelAction(id, { at }));
  }

  retryAction(id: string): void {
    this.withActionManager((manager) => manager.retryAction(id));
  }

  archiveAction(id: string): void {
    this.withActionManager((manager) => ({ manager: manager.archiveAction(id) }));
  }

  restoreAction(id: string): void {
    this.withActionManager((manager) => ({ manager: manager.restoreAction(id) }));
  }

  deleteAction(id: string): void {
    this.withActionManager((manager) => ({ manager: manager.deleteAction(id) }));
  }

  // ─────────────────────────────────────────────────────────────────────
  // Workflow operations (composition-root).
  // ─────────────────────────────────────────────────────────────────────

  listWorkflows() {
    return this._workflows.manager.list();
  }

  findWorkflow(id: string) {
    return this._workflows.findWorkflow(id);
  }

  registerWorkflow(workflow: Parameters<WorkflowManager["repository"]["add"]>[0]) {
    const { repository } = this._workflows.manager.repository.add(workflow);
    this.setWorkflowManager(new WorkflowManager(repository));
    this.rebuild();
    return this._workflows.manager.find(workflow.id);
  }

  async runWorkflow(workflow: Parameters<WorkflowEngine["runWorkflow"]>[0], options?: Parameters<WorkflowEngine["runWorkflow"]>[1]) {
    const result = await this._workflows.runWorkflow(workflow, options);
    this.reconcile();
    return result;
  }

  async triggerWorkflow(event: Parameters<WorkflowEngine["triggerWorkflow"]>[0], options?: Parameters<WorkflowEngine["triggerWorkflow"]>[1]) {
    const result = await this._workflows.triggerWorkflow(event, options);
    this.reconcile();
    return result;
  }

  planWorkflow(workflow: Parameters<WorkflowEngine["plan"]>[0], options: Parameters<WorkflowEngine["plan"]>[1]) {
    return this._workflows.plan(workflow, options);
  }

  /** Apply a manager-level workflow operation and rebuild the graph. */
  private withWorkflowManager(apply: (manager: WorkflowManager) => { manager: WorkflowManager }): void {
    const { manager } = apply(this._workflows.manager);
    this.setWorkflowManager(manager);
    this.rebuild();
  }

  disableWorkflow(id: string): void {
    this.withWorkflowManager((manager) => ({ manager: manager.disableWorkflow(id) }));
  }

  enableWorkflow(id: string): void {
    this.withWorkflowManager((manager) => ({ manager: manager.enableWorkflow(id) }));
  }

  archiveWorkflow(id: string): void {
    this.withWorkflowManager((manager) => ({ manager: manager.archiveWorkflow(id) }));
  }

  restoreWorkflow(id: string): void {
    this.withWorkflowManager((manager) => ({ manager: manager.restoreWorkflow(id) }));
  }

  deleteWorkflow(id: string): void {
    this.withWorkflowManager((manager) => ({ manager: manager.deleteWorkflow(id) }));
  }

  // ─────────────────────────────────────────────────────────────────────
  // Graph wiring.
  // ─────────────────────────────────────────────────────────────────────

  /**
   * The digest data sources over the *app* engines (application wiring —
   * see the module docstring). The digest builder is reused; only its
   * sources are wired to the app engine set.
   */
  private appDigestSources(): DigestDataSources {
    return {
      listMemories: () => this._memory.listMemories(),
      listConversations: () => this._conversation.listConversations(),
      buildContextPrompt: (query, userId) =>
        this.context.buildPrompt({
          retrievalQuery: { userId, query },
          tokenBudget: DIGEST_CONTEXT_TOKEN_BUDGET,
          userQuery: query,
        }),
      listJobs: () => this._jobs.manager.list(),
      executeTools: (plan) =>
        this.digestToolExecutor.execute(plan, { timeoutMs: DIGEST_TOOL_TIMEOUT_MS }),
    };
  }

  /**
   * Reconcile the app-level memory/conversation engines with the state
   * advanced inside the composition roots.
   *
   * Background jobs, actions, and workflow steps write memories and
   * conversation notes through their own engine references (the roots are
   * seeded with the app engines at rebuild time and advance them in place).
   * After every execution path that can write, the app-level engines are
   * rebuilt as the merge — by id, preserving first-seen insertion order — of
   * the app engine and every root's view, then the graph is rebuilt so each
   * root observes the reconciled state.
   */
  private reconcile(): void {
    const memories = new Map<string, Memory>();
    const conversations = new Map<string, Conversation>();
    const memoryEngines = [this._memory, this._jobs.memoryEngine, this._actions.memoryEngine];
    const conversationEngines = [
      this._conversation,
      this._jobs.conversationEngine,
      this._actions.conversationEngine,
    ];
    for (const engine of memoryEngines) {
      for (const memory of engine.listMemories()) memories.set(memory.id, memory);
    }
    for (const engine of conversationEngines) {
      for (const conversation of engine.listConversations()) {
        conversations.set(conversation.id, conversation);
      }
    }
    this._memory = createProductionMemoryEngine(
      new MemoryRepository([...memories.values()]),
    );
    this._conversation = createProductionConversationEngine(
      new ConversationRepository([...conversations.values()]),
    );
    this.rebuild();
  }

  /** Rebuild the four composition roots bottom-up over current state. */
  private rebuild(): void {
    this.setDigestManager(this._digest.manager);
    this.setJobManager(this._jobs.manager);
    this.setActionManager(this._actions.manager);
    this.setWorkflowManager(this._workflows.manager);
  }

  private setDigestManager(manager: DigestManager): void {
    this._digest = new DigestEngine({
      manager,
      sources: this.appDigestSources(),
      now: this.now,
    });
  }

  private setJobManager(manager: JobManager): void {
    const options: JobEngineOptions = {
      manager,
      memoryEngine: this._memory,
      conversationEngine: this._conversation,
      contextEngine: this.context,
      seedDigestJob: false,
      now: this.now,
    };
    this._jobs = new JobEngine(options);
  }

  private setActionManager(manager: ActionManager): void {
    this._actions = new ActionEngine({
      manager,
      memoryEngine: this._memory,
      conversationEngine: this._conversation,
      digestEngine: this._digest,
      jobEngine: this._jobs,
      contextEngine: this.context,
      now: this.now,
    });
  }

  private setWorkflowManager(manager: WorkflowManager): void {
    this._workflows = new WorkflowEngine({
      manager,
      actionEngine: this._actions,
      jobEngine: this._jobs,
      digestEngine: this._digest,
      contextEngine: this.context,
      now: this.now,
    });
  }
}

/**
 * Build a fresh application engines root, seeded from the production
 * singletons.
 */
export function createApplicationEngines(options: ApplicationEnginesOptions = {}): ApplicationEngines {
  return new ApplicationEngines(options);
}

/**
 * The application's single engine root instance (module-level singleton).
 */
const productionApplicationEngines = createApplicationEngines();

/** Return the application's single engine root instance. */
export function getApplicationEngines(): ApplicationEngines {
  return productionApplicationEngines;
}
