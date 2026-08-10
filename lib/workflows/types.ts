/**
 * Workflow Engine — immutable domain models.
 *
 * Step 1 of the Workflow Engine framework: the pure, readonly data model for
 * workflows plus the pure helper functions that construct, clone, freeze,
 * touch, schedule, and measure them.
 *
 * No services, no LLM, no database, no timers, and no side effects live here
 * — only data and pure functions. Every function is deterministic: identical
 * inputs always produce identical outputs, and caller-supplied
 * objects/arrays are never referenced or mutated (they are copied on entry,
 * and the returned structures are detached).
 *
 * Timestamps are always supplied by the caller (no `Date.now()`) so every
 * operation stays pure and reproducible. Schedule math reuses the jobs
 * layer's `JobSchedule`/`nextOccurrence` — the workflow layer never
 * reimplements occurrence logic.
 */

import { nextOccurrence, type JobSchedule } from "@/lib/jobs/types";
import type { PlanActionRequest } from "@/lib/actions/planner";
import type { DigestTemplate } from "@/lib/digest/types";
import type { ExecutionPlan } from "@/lib/tools/plan";

/** Lifecycle state of a workflow. */
export type WorkflowStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped";

/** Execution priority of a workflow — drives plan ordering. */
export type WorkflowPriority = "low" | "normal" | "high" | "critical";

/** How a workflow is launched. */
export type WorkflowTriggerKind =
  | "manual"
  | "scheduled"
  | "conversation"
  | "memory"
  | "digest"
  | "job"
  | "action"
  | "tool";

/** The kind of work a workflow step performs. */
export type WorkflowActionKind = "action" | "job" | "tool" | "digest";

/** Comparison operators supported by {@link WorkflowCondition}. */
export type WorkflowConditionOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "exists";

/** Default status assigned by `createWorkflow` when none is provided. */
export const DEFAULT_WORKFLOW_STATUS: WorkflowStatus = "pending";

/** Default priority assigned by `createWorkflow` when none is provided. */
export const DEFAULT_WORKFLOW_PRIORITY: WorkflowPriority = "normal";

/** Default trigger kind assigned by `createWorkflow` when none is provided. */
export const DEFAULT_WORKFLOW_TRIGGER: WorkflowTriggerKind = "manual";

/** Default attempt budget assigned by `createWorkflow` (no retries unless configured). */
export const DEFAULT_WORKFLOW_MAX_ATTEMPTS = 1;

/** Default archived flag assigned by `createWorkflow`. */
export const DEFAULT_WORKFLOW_ARCHIVED = false;

/** Default enabled flag assigned by `createWorkflow`. */
export const DEFAULT_WORKFLOW_ENABLED = true;

/**
 * Deterministic ordering rank of each priority — higher runs first.
 * `critical` (3) > `high` (2) > `normal` (1) > `low` (0).
 */
export const PRIORITY_RANK: Readonly<Record<WorkflowPriority, number>> = Object.freeze({
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
});

/**
 * Base execution-cost heuristic of each priority, used by
 * `estimateWorkflowCost` when a workflow carries no explicit `costUnits`.
 */
export const PRIORITY_COST: Readonly<Record<WorkflowPriority, number>> = Object.freeze({
  low: 1,
  normal: 2,
  high: 4,
  critical: 8,
});

/**
 * The launch configuration of a workflow.
 *
 * - `manual` workflows run when triggered by hand (or via a manual trigger
 *   event); they carry no schedule.
 * - `scheduled` workflows fire when their `schedule` is due (the schedule
 *   reuses the jobs layer's `JobSchedule`, including one-time and recurring
 *   shapes).
 * - `conversation` / `memory` / `digest` / `job` / `action` / `tool`
 *   workflows fire on the corresponding engine signal; the optional
 *   `<x>Id` narrows the signal to a specific entity and the optional `event`
 *   qualifier narrows it further (e.g. `"completed"`).
 */
export interface WorkflowTrigger {
  readonly kind: WorkflowTriggerKind;
  /** Due-schedule for `scheduled` workflows (reused from the jobs layer). */
  readonly schedule?: JobSchedule;
  /** Optional qualifier (e.g. `"completed"`, `"added"`, `"generated"`). */
  readonly event?: string;
  /** Conversation this workflow watches, when applicable. */
  readonly conversationId?: string;
  /** Memory this workflow watches, when applicable. */
  readonly memoryId?: string;
  /** Digest this workflow watches, when applicable. */
  readonly digestId?: string;
  /** Job this workflow watches, when applicable. */
  readonly jobId?: string;
  /** Action this workflow watches, when applicable. */
  readonly actionId?: string;
  /** Tool this workflow watches, when applicable. */
  readonly toolId?: string;
}

/**
 * A pure predicate over a signal object (see `evaluateCondition`).
 *
 * `field` is a dot path into the signal (e.g. `"memory.kind"`); the
 * operators compare the resolved value against `value`. `"exists"` ignores
 * `value`. Deterministic — no side effects.
 */
export interface WorkflowCondition {
  /** Dot path into the signal object. */
  readonly field: string;
  readonly operator: WorkflowConditionOperator;
  /** The value compared against (ignored by `"exists"`). */
  readonly value?: unknown;
}

/**
 * The work a single workflow step performs.
 *
 * - `"action"` steps delegate to the Action Planner + Action Executor:
 *   `intent` (free text) and/or `requests` (explicit action requests) are
 *   planned into an `ActionPlan` and executed by the injected Action Engine.
 * - `"job"` steps run an existing background job by id through the Job
 *   Engine (no new job is created).
 * - `"tool"` steps execute an already-built tool `plan` through the Tool
 *   Executor.
 * - `"digest"` steps build a digest from `template` through the Digest
 *   Engine.
 *
 * Exactly one of the fields is meaningful per `kind`; the others default to
 * `undefined`.
 */
export interface WorkflowAction {
  readonly kind: WorkflowActionKind;
  /** `"action"`: the intent text planned via the Action Planner. */
  readonly intent?: string;
  /** `"action"`: explicit action requests planned via the Action Planner. */
  readonly requests?: readonly PlanActionRequest[];
  /** `"job"`: the id of the background job to run. */
  readonly jobId?: string;
  /** `"tool"`: the immutable execution plan to execute. */
  readonly plan?: ExecutionPlan;
  /** `"digest"`: the digest template to build. */
  readonly template?: DigestTemplate;
  /** `"digest"`: free-text query forwarded to the digest builder. */
  readonly query?: string;
}

/**
 * A single workflow step: one piece of work with an ordering constraint.
 */
export interface WorkflowStep {
  /** Stable step id unique within the workflow. */
  readonly id: string;
  /** Human-readable step name. */
  readonly name: string;
  readonly action: WorkflowAction;
  /** Step ids this step depends on (execution-order constraint). */
  readonly dependsOn: readonly string[];
  readonly priority: WorkflowPriority;
  /** Per-step attempt budget; defaults to the workflow's `maxAttempts`. */
  readonly maxAttempts?: number;
  /** Per-step execution timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Delay between retry attempts in milliseconds. */
  readonly retryDelayMs?: number;
  /** When set, the step runs only if the condition passes at plan time. */
  readonly condition?: WorkflowCondition;
}

/** Structured error attached to a failed or cancelled workflow. */
export interface WorkflowError {
  /** Stable machine-readable code, e.g. "timeout", "handler_error". */
  readonly code: string;
  /** Human-readable detail. */
  readonly message: string;
}

/** Structured outcome of a completed workflow run. */
export interface WorkflowResult {
  /** True when the run produced a useful output. */
  readonly success: boolean;
  /** The workflow's output on success. */
  readonly output?: unknown;
  /** Optional human-readable note about the run. */
  readonly message?: string;
  /** Wall-clock duration of the run in milliseconds. */
  readonly durationMs?: number;
}

/**
 * A single recorded execution of a workflow.
 *
 * One execution is appended when a workflow starts and finalized (status,
 * finishedAt, error/result, durationMs) when it settles.
 */
export interface WorkflowExecution {
  /** Stable execution id; deterministic when derived by `createWorkflowExecution`. */
  readonly id: string;
  /** The workflow this execution belongs to. */
  readonly workflowId: string;
  /** 1-based attempt number within the workflow's run. */
  readonly attempt: number;
  /** The execution's lifecycle state. */
  readonly status: WorkflowStatus;
  /** ISO-8601 UTC timestamp of the attempt's start. */
  readonly startedAt: string;
  /** ISO-8601 UTC timestamp of the attempt's settlement, when settled. */
  readonly finishedAt?: string;
  /** Structured failure/cancellation detail, when not successful. */
  readonly error?: WorkflowError;
  /** Structured outcome, when the attempt completed. */
  readonly result?: WorkflowResult;
  /** Wall-clock duration of the attempt in milliseconds, when settled. */
  readonly durationMs?: number;
}

/**
 * Structured metadata of a workflow.
 *
 * `timeoutMs`, `retryDelayMs`, and `costUnits` are execution hints honored by
 * the executor and the pure cost estimator; `tags` are stable labels.
 */
export interface WorkflowMetadata {
  /** Stable tags; defaults to an empty array when created. */
  readonly tags: readonly string[];
  /** Per-attempt execution timeout in milliseconds (none when omitted). */
  readonly timeoutMs?: number;
  /** Delay between retry attempts in milliseconds (defaults to 0). */
  readonly retryDelayMs?: number;
  /** Explicit execution-cost units overriding the priority heuristic. */
  readonly costUnits?: number;
}

/**
 * An immutable workflow.
 *
 * `status` drives schedulability; `trigger`/`scheduledAt` drive *when* it is
 * due; `steps` are the immutable plan of work (validated acyclic by
 * `createWorkflow`); `attempts` counts started runs; `executions` is the full
 * run history.
 */
export interface Workflow {
  /** Stable workflow id; deterministic when derived by `createWorkflow`. */
  readonly id: string;
  /** Human-readable workflow name. */
  readonly name: string;
  /** Optional human-readable description. */
  readonly description?: string;
  readonly status: WorkflowStatus;
  readonly priority: WorkflowPriority;
  readonly trigger: WorkflowTrigger;
  /** The immutable steps, in declared order (validated acyclic). */
  readonly steps: readonly WorkflowStep[];
  /** Number of times the workflow has been started. */
  readonly attempts: number;
  /** Total attempt budget (retries are `maxAttempts − 1`). */
  readonly maxAttempts: number;
  /** ISO-8601 UTC timestamp of the workflow's creation. */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the next/only scheduled run. */
  readonly scheduledAt?: string;
  /** ISO-8601 UTC timestamp of the most recent start. */
  readonly startedAt?: string;
  /** ISO-8601 UTC timestamp of the most recent completion. */
  readonly completedAt?: string;
  /** When true, the workflow is excluded from scheduling (see `archiveWorkflow`). */
  readonly archived: boolean;
  /** When false, the workflow never fires (see `disableWorkflow`). */
  readonly enabled: boolean;
  /** Structured failure/cancellation detail of the most recent run. */
  readonly error?: WorkflowError;
  /** Structured outcome of the most recent completed run. */
  readonly result?: WorkflowResult;
  readonly metadata: WorkflowMetadata;
  /** Run history, oldest first. */
  readonly executions: readonly WorkflowExecution[];
  /** Conversation this workflow is linked to, when applicable. */
  readonly conversationId?: string;
  /** Memory this workflow is linked to, when applicable. */
  readonly memoryId?: string;
  /** Job this workflow is linked to, when applicable. */
  readonly jobId?: string;
  /** Digest this workflow is linked to, when applicable. */
  readonly digestId?: string;
}

/**
 * Lightweight projection of a workflow for list/overview views.
 */
export interface WorkflowSummary {
  readonly id: string;
  readonly name: string;
  readonly status: WorkflowStatus;
  readonly priority: WorkflowPriority;
  readonly trigger: WorkflowTriggerKind;
  /** ISO-8601 UTC timestamp of the workflow's creation. */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the next/only scheduled run. */
  readonly scheduledAt?: string;
  readonly stepCount: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly archived: boolean;
  readonly enabled: boolean;
  /** Estimated execution cost (see `estimateWorkflowCost`). */
  readonly costEstimate: number;
}

/**
 * The run history of a single workflow — the dedupe/citation key of the
 * workflow layer.
 */
export interface WorkflowHistory {
  readonly workflowId: string;
  readonly executions: readonly WorkflowExecution[];
}

/**
 * A stable reference to a workflow — the lightweight handle used to address
 * a workflow without carrying its full state.
 */
export interface WorkflowReference {
  readonly workflowId: string;
  /** The trigger kind that launches the workflow, when known. */
  readonly trigger?: WorkflowTriggerKind;
}

/**
 * Runtime context handed to a workflow step handler at execution time.
 *
 * Carries the current workflow (in its `running` state), the 1-based attempt
 * number, the executor's cancellation signal (a cooperative handler may stop
 * early), and the injected current time — so handlers stay deterministic.
 */
export interface WorkflowContext {
  /** The workflow being executed (status `"running"`). */
  readonly workflow: Workflow;
  /** 1-based attempt number within the workflow's run. */
  readonly attempt: number;
  /** Abort signal observed by the executor; handlers may honor it. */
  readonly signal?: AbortSignal;
  /** ISO-8601 UTC timestamp of the run start (injected, deterministic). */
  readonly now: string;
}

/**
 * Deterministic 32-bit FNV-1a hash of `value`, rendered as lowercase hex.
 * Used to derive stable workflow/execution ids from a workflow's own
 * contents, so `createWorkflow`/`createWorkflowExecution` stay pure and
 * deterministic. (The job/action/digest/memory/conversation layers own
 * sibling hashes; this layer follows the same per-layer convention.)
 */
export function hashWorkflow(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Deterministic workflow id derived from the workflow's own contents. */
function workflowIdFor(
  name: string,
  triggerKind: WorkflowTriggerKind,
  priority: WorkflowPriority,
  createdAt: string,
  scheduledAt: string | undefined,
): string {
  return `workflow-${hashWorkflow(`${name}:${triggerKind}:${priority}:${createdAt}:${scheduledAt ?? ""}`)}`;
}

/** Options accepted by {@link createWorkflowStep}. */
export interface CreateWorkflowStepInput {
  readonly id: string;
  readonly name: string;
  readonly action: WorkflowAction;
  /** Step ids this step depends on (execution-order constraint). */
  readonly dependsOn?: readonly string[];
  readonly priority?: WorkflowPriority;
  /** Per-step attempt budget; defaults to the workflow's `maxAttempts`. */
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly condition?: WorkflowCondition;
}

/**
 * Build a new immutable workflow step.
 *
 * `dependsOn` is copied as a new array; `condition` is copied as a new
 * record. The returned object is new and detached from all inputs.
 */
export function createWorkflowStep(input: CreateWorkflowStepInput): WorkflowStep {
  return {
    id: input.id,
    name: input.name,
    action: cloneWorkflowAction(input.action),
    dependsOn: input.dependsOn !== undefined ? [...input.dependsOn] : [],
    priority: input.priority ?? DEFAULT_WORKFLOW_PRIORITY,
    ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.retryDelayMs !== undefined ? { retryDelayMs: input.retryDelayMs } : {}),
    ...(input.condition !== undefined ? { condition: { ...input.condition } } : {}),
  };
}

/**
 * Copy of a workflow action (new record, arrays copied).
 *
 * `plan` and `template` are shared by reference — they are immutable,
 * deep-frozen values produced by the tools/digest layers (`createExecutionPlan`
 * freezes tool plans), so sharing is safe and avoids re-cloning frozen trees.
 */
function cloneWorkflowAction(action: WorkflowAction): WorkflowAction {
  return {
    kind: action.kind,
    ...(action.intent !== undefined ? { intent: action.intent } : {}),
    ...(action.requests !== undefined ? { requests: [...action.requests] } : {}),
    ...(action.jobId !== undefined ? { jobId: action.jobId } : {}),
    ...(action.plan !== undefined ? { plan: action.plan } : {}),
    ...(action.template !== undefined ? { template: action.template } : {}),
    ...(action.query !== undefined ? { query: action.query } : {}),
  };
}

/** Options accepted by {@link createWorkflow}. */
export interface CreateWorkflowInput {
  /** Explicit id; when omitted, one is derived deterministically. */
  readonly id?: string;
  readonly name: string;
  readonly description?: string;
  readonly status?: WorkflowStatus;
  readonly priority?: WorkflowPriority;
  readonly trigger?: WorkflowTrigger;
  /** The immutable steps (validated: unique ids, known deps, acyclic). */
  readonly steps: readonly WorkflowStep[];
  /** Attempt budget; defaults to 1 (no retries). */
  readonly maxAttempts?: number;
  /** Started-run count; defaults to 0. */
  readonly attempts?: number;
  /** ISO-8601 UTC timestamp of the workflow's creation. */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the next/only scheduled run. */
  readonly scheduledAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly archived?: boolean;
  readonly enabled?: boolean;
  readonly error?: WorkflowError;
  readonly result?: WorkflowResult;
  readonly metadata?: Partial<WorkflowMetadata>;
  readonly executions?: readonly WorkflowExecution[];
  readonly conversationId?: string;
  readonly memoryId?: string;
  readonly jobId?: string;
  readonly digestId?: string;
}

/**
 * Build a new immutable workflow.
 *
 * - `id` defaults to a deterministic hash of name + trigger kind + priority +
 *   createdAt + scheduledAt. Derived ids are stable but not guaranteed unique
 *   across workflows with identical inputs; callers that need uniqueness
 *   should pass an explicit `id`.
 * - `status` defaults to `"pending"`, `priority` to `"normal"`, `trigger` to
 *   `{ kind: "manual" }`, `maxAttempts` to 1, `archived` to false, `enabled`
 *   to true, and `metadata.tags` to `[]`.
 * - When `scheduledAt` is omitted and the trigger carries a schedule, it is
 *   defaulted deterministically: a one-time schedule's `at`, else the
 *   recurring schedule's `startsAt` — and, mirroring the jobs layer (see
 *   `createJob`), a recurring schedule without `startsAt` is defaulted to
 *   `createdAt` (so a recurring workflow always carries a concrete
 *   `scheduledAt` and is reschedulable).
 * - The steps are validated (unique ids, known dependency references, no
 *   self-dependencies, no cycles) and copied step-by-step. The returned
 *   object is new and detached from all inputs.
 */
export function createWorkflow(input: CreateWorkflowInput): Workflow {
  assertValidSteps(input.steps);

  const schedule = cloneScheduleWithDefaults(input.trigger?.schedule, input.createdAt);

  const trigger: WorkflowTrigger = {
    kind: input.trigger?.kind ?? DEFAULT_WORKFLOW_TRIGGER,
    ...(schedule !== undefined ? { schedule } : {}),
    ...(input.trigger?.event !== undefined ? { event: input.trigger.event } : {}),
    ...(input.trigger?.conversationId !== undefined ? { conversationId: input.trigger.conversationId } : {}),
    ...(input.trigger?.memoryId !== undefined ? { memoryId: input.trigger.memoryId } : {}),
    ...(input.trigger?.digestId !== undefined ? { digestId: input.trigger.digestId } : {}),
    ...(input.trigger?.jobId !== undefined ? { jobId: input.trigger.jobId } : {}),
    ...(input.trigger?.actionId !== undefined ? { actionId: input.trigger.actionId } : {}),
    ...(input.trigger?.toolId !== undefined ? { toolId: input.trigger.toolId } : {}),
  };

  let scheduledAt = input.scheduledAt;
  if (scheduledAt === undefined && schedule !== undefined) {
    scheduledAt = schedule.at ?? schedule.startsAt;
  }

  const metadata: WorkflowMetadata = {
    tags: input.metadata?.tags !== undefined ? [...input.metadata.tags] : [],
    ...(input.metadata?.timeoutMs !== undefined
      ? { timeoutMs: input.metadata.timeoutMs }
      : {}),
    ...(input.metadata?.retryDelayMs !== undefined
      ? { retryDelayMs: input.metadata.retryDelayMs }
      : {}),
    ...(input.metadata?.costUnits !== undefined ? { costUnits: input.metadata.costUnits } : {}),
  };

  return {
    id:
      input.id ??
      workflowIdFor(
        input.name,
        trigger.kind,
        input.priority ?? DEFAULT_WORKFLOW_PRIORITY,
        input.createdAt,
        scheduledAt,
      ),
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    status: input.status ?? DEFAULT_WORKFLOW_STATUS,
    priority: input.priority ?? DEFAULT_WORKFLOW_PRIORITY,
    trigger,
    steps: input.steps.map((step) => createWorkflowStep(step)),
    attempts: input.attempts ?? 0,
    maxAttempts: input.maxAttempts ?? DEFAULT_WORKFLOW_MAX_ATTEMPTS,
    createdAt: input.createdAt,
    ...(scheduledAt !== undefined ? { scheduledAt } : {}),
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    archived: input.archived ?? DEFAULT_WORKFLOW_ARCHIVED,
    enabled: input.enabled ?? DEFAULT_WORKFLOW_ENABLED,
    ...(input.error !== undefined ? { error: { ...input.error } } : {}),
    ...(input.result !== undefined ? { result: cloneWorkflowResult(input.result) } : {}),
    metadata,
    executions: input.executions !== undefined ? [...input.executions] : [],
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    ...(input.memoryId !== undefined ? { memoryId: input.memoryId } : {}),
    ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    ...(input.digestId !== undefined ? { digestId: input.digestId } : {}),
  };
}

/**
 * Validate a candidate step list: unique step ids, dependencies referencing
 * existing steps (not themselves), and an acyclic dependency graph. Throws
 * on the first violation.
 */
function assertValidSteps(steps: readonly WorkflowStep[]): void {
  const stepIds = new Set<string>();
  for (const step of steps) {
    if (stepIds.has(step.id)) {
      throw new Error(`Workflow contains duplicate step id "${step.id}"`);
    }
    stepIds.add(step.id);
  }

  for (const step of steps) {
    if (step.dependsOn.includes(step.id)) {
      throw new Error(`Workflow step "${step.id}" depends on itself`);
    }
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) {
        throw new Error(`Workflow step "${step.id}" depends on unknown step "${dependency}"`);
      }
    }
  }

  // Cycle detection via Kahn's algorithm (deterministic; order-independent).
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const step of steps) {
    indegree.set(step.id, 0);
    adjacency.set(step.id, []);
  }
  for (const step of steps) {
    for (const dependency of new Set(step.dependsOn)) {
      adjacency.get(dependency)?.push(step.id);
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
    }
  }
  const ready: string[] = steps
    .filter((step) => (indegree.get(step.id) ?? 0) === 0)
    .map((step) => step.id);
  let processed = 0;
  while (ready.length > 0) {
    const current = ready.shift() ?? "";
    processed += 1;
    for (const next of adjacency.get(current) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if ((indegree.get(next) ?? 0) === 0) ready.push(next);
    }
  }
  if (processed !== steps.length) {
    throw new Error("Workflow contains a dependency cycle");
  }
}

/** Options accepted by {@link createWorkflowExecution}. */
export interface CreateWorkflowExecutionInput {
  /** Explicit id; when omitted, one is derived deterministically. */
  readonly id?: string;
  readonly workflowId: string;
  /** 1-based attempt number within the workflow's run. */
  readonly attempt: number;
  readonly status: WorkflowStatus;
  /** ISO-8601 UTC timestamp of the attempt's start. */
  readonly startedAt: string;
  /** ISO-8601 UTC timestamp of the attempt's settlement, when settled. */
  readonly finishedAt?: string;
  readonly error?: WorkflowError;
  readonly result?: WorkflowResult;
  /** Wall-clock duration of the attempt in milliseconds, when settled. */
  readonly durationMs?: number;
}

/**
 * Build a new immutable execution record.
 *
 * `id` defaults to a deterministic hash of workflowId + attempt + startedAt +
 * status. `error`/`result` are copied as new records; the returned object is
 * new and detached from all inputs.
 */
export function createWorkflowExecution(input: CreateWorkflowExecutionInput): WorkflowExecution {
  return {
    id:
      input.id ??
      `exec-workflow-${hashWorkflow(`${input.workflowId}:${input.attempt}:${input.startedAt}:${input.status}`)}`,
    workflowId: input.workflowId,
    attempt: input.attempt,
    status: input.status,
    startedAt: input.startedAt,
    ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
    ...(input.error !== undefined ? { error: { ...input.error } } : {}),
    ...(input.result !== undefined ? { result: cloneWorkflowResult(input.result) } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  };
}

/**
 * A partial patch applied by {@link touchWorkflow} (and the repository's
 * `update`).
 *
 * Keys present in the patch are applied; missing keys are preserved. A `null`
 * value clears the corresponding optional field.
 */
export type WorkflowPatch = Partial<{
  name: string;
  description: string | null;
  status: WorkflowStatus;
  priority: WorkflowPriority;
  trigger: WorkflowTrigger;
  steps: readonly WorkflowStep[];
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  archived: boolean;
  enabled: boolean;
  error: WorkflowError | null;
  result: WorkflowResult | null;
  tags: readonly string[];
  timeoutMs: number | null;
  retryDelayMs: number | null;
  costUnits: number | null;
  executions: readonly WorkflowExecution[];
  conversationId: string | null;
  memoryId: string | null;
  jobId: string | null;
  digestId: string | null;
}>;

/**
 * Return the successor workflow with the patch applied.
 *
 * Missing patch keys are preserved; `steps`, `tags`, and `executions` are
 * copied; a `null` value clears an optional field. A patched `steps` array is
 * re-validated (see `assertValidSteps`). Deterministic; the input is never
 * mutated.
 */
export function touchWorkflow(workflow: Workflow, patch: WorkflowPatch): Workflow {
  const steps = patch.steps !== undefined ? patch.steps : workflow.steps;
  if (patch.steps !== undefined) assertValidSteps(steps);

  const metadata: WorkflowMetadata = {
    tags: patch.tags !== undefined ? [...patch.tags] : [...workflow.metadata.tags],
    ...(patch.timeoutMs !== undefined
      ? patch.timeoutMs !== null
        ? { timeoutMs: patch.timeoutMs }
        : {}
      : workflow.metadata.timeoutMs !== undefined
        ? { timeoutMs: workflow.metadata.timeoutMs }
        : {}),
    ...(patch.retryDelayMs !== undefined
      ? patch.retryDelayMs !== null
        ? { retryDelayMs: patch.retryDelayMs }
        : {}
      : workflow.metadata.retryDelayMs !== undefined
        ? { retryDelayMs: workflow.metadata.retryDelayMs }
        : {}),
    ...(patch.costUnits !== undefined
      ? patch.costUnits !== null
        ? { costUnits: patch.costUnits }
        : {}
      : workflow.metadata.costUnits !== undefined
        ? { costUnits: workflow.metadata.costUnits }
        : {}),
  };

  return {
    id: workflow.id,
    name: patch.name ?? workflow.name,
    ...(patch.description !== undefined
      ? patch.description !== null
        ? { description: patch.description }
        : {}
      : workflow.description !== undefined
        ? { description: workflow.description }
        : {}),
    status: patch.status ?? workflow.status,
    priority: patch.priority ?? workflow.priority,
    trigger:
      patch.trigger !== undefined
        ? cloneTrigger(patch.trigger)
        : cloneTrigger(workflow.trigger),
    steps: steps.map((step) => createWorkflowStep(step)),
    attempts: patch.attempts ?? workflow.attempts,
    maxAttempts: patch.maxAttempts ?? workflow.maxAttempts,
    createdAt: patch.createdAt ?? workflow.createdAt,
    ...(patch.scheduledAt !== undefined
      ? patch.scheduledAt !== null
        ? { scheduledAt: patch.scheduledAt }
        : {}
      : workflow.scheduledAt !== undefined
        ? { scheduledAt: workflow.scheduledAt }
        : {}),
    ...(patch.startedAt !== undefined
      ? patch.startedAt !== null
        ? { startedAt: patch.startedAt }
        : {}
      : workflow.startedAt !== undefined
        ? { startedAt: workflow.startedAt }
        : {}),
    ...(patch.completedAt !== undefined
      ? patch.completedAt !== null
        ? { completedAt: patch.completedAt }
        : {}
      : workflow.completedAt !== undefined
        ? { completedAt: workflow.completedAt }
        : {}),
    archived: patch.archived ?? workflow.archived,
    enabled: patch.enabled ?? workflow.enabled,
    ...(patch.error !== undefined
      ? patch.error !== null
        ? { error: { ...patch.error } }
        : {}
      : workflow.error !== undefined
        ? { error: { ...workflow.error } }
        : {}),
    ...(patch.result !== undefined
      ? patch.result !== null
        ? { result: cloneWorkflowResult(patch.result) }
        : {}
      : workflow.result !== undefined
        ? { result: cloneWorkflowResult(workflow.result) }
        : {}),
    metadata,
    executions: patch.executions !== undefined ? [...patch.executions] : [...workflow.executions],
    ...(patch.conversationId !== undefined
      ? patch.conversationId !== null
        ? { conversationId: patch.conversationId }
        : {}
      : workflow.conversationId !== undefined
        ? { conversationId: workflow.conversationId }
        : {}),
    ...(patch.memoryId !== undefined
      ? patch.memoryId !== null
        ? { memoryId: patch.memoryId }
        : {}
      : workflow.memoryId !== undefined
        ? { memoryId: workflow.memoryId }
        : {}),
    ...(patch.jobId !== undefined
      ? patch.jobId !== null
        ? { jobId: patch.jobId }
        : {}
      : workflow.jobId !== undefined
        ? { jobId: workflow.jobId }
        : {}),
    ...(patch.digestId !== undefined
      ? patch.digestId !== null
        ? { digestId: patch.digestId }
        : {}
      : workflow.digestId !== undefined
        ? { digestId: workflow.digestId }
        : {}),
  };
}

/**
 * Deep-freeze a workflow in place and return it.
 *
 * Freezes the workflow, its metadata (and `tags`), its trigger (and schedule),
 * the steps array, and every step (and their actions, `dependsOn`, and
 * conditions), its error/result records, the executions array, and every
 * execution (and their nested error/result records). Idempotent: freezing an
 * already frozen workflow is a no-op.
 */
export function freezeWorkflow(workflow: Workflow): Workflow {
  Object.freeze(workflow.metadata.tags);
  Object.freeze(workflow.metadata);
  Object.freeze(workflow.trigger);
  if (workflow.trigger.schedule !== undefined) Object.freeze(workflow.trigger.schedule);
  if (workflow.error !== undefined) Object.freeze(workflow.error);
  if (workflow.result !== undefined) Object.freeze(workflow.result);
  for (const step of workflow.steps) {
    Object.freeze(step.action);
    if (step.action.requests !== undefined) Object.freeze(step.action.requests);
    if (step.action.plan !== undefined) Object.freeze(step.action.plan);
    Object.freeze(step.dependsOn);
    if (step.condition !== undefined) Object.freeze(step.condition);
    Object.freeze(step);
  }
  Object.freeze(workflow.steps);
  for (const execution of workflow.executions) {
    if (execution.error !== undefined) Object.freeze(execution.error);
    if (execution.result !== undefined) Object.freeze(execution.result);
    Object.freeze(execution);
  }
  Object.freeze(workflow.executions);
  Object.freeze(workflow);
  return workflow;
}

/**
 * Return a deep, detached copy of a workflow.
 *
 * Every object is new — the workflow, its metadata (and `tags`), its trigger
 * (and schedule), the steps array, and each step (and their actions,
 * `dependsOn`, and conditions), its error/result records, the executions
 * array, and each execution (and their nested records). The clone is not
 * frozen (call `freezeWorkflow` to freeze it). Values, including optional
 * fields, are preserved exactly.
 */
export function cloneWorkflow(workflow: Workflow): Workflow {
  return touchWorkflow(workflow, {
    executions: workflow.executions.map((execution) =>
      createWorkflowExecution({
        id: execution.id,
        workflowId: execution.workflowId,
        attempt: execution.attempt,
        status: execution.status,
        startedAt: execution.startedAt,
        ...(execution.finishedAt !== undefined ? { finishedAt: execution.finishedAt } : {}),
        ...(execution.error !== undefined ? { error: { ...execution.error } } : {}),
        ...(execution.result !== undefined ? { result: cloneWorkflowResult(execution.result) } : {}),
        ...(execution.durationMs !== undefined ? { durationMs: execution.durationMs } : {}),
      }),
    ),
  });
}

/**
 * Whether a workflow is runnable at `now`.
 *
 * A pending, non-archived, enabled workflow is runnable when:
 * - it has no schedule (manual/conversation/memory/digest/job/action/tool
 *   workflows are runnable whenever they are pending), or
 * - its `scheduledAt` is defined and at or before `now`.
 *
 * Deterministic — `now` is supplied by the caller.
 */
export function isWorkflowRunnable(workflow: Workflow, now: string): boolean {
  if (workflow.status !== "pending" || workflow.archived || !workflow.enabled) return false;
  if (workflow.scheduledAt === undefined) return true;
  return Date.parse(workflow.scheduledAt) <= Date.parse(now);
}

/**
 * The next occurrence of `schedule` strictly after `after` (ISO-8601 UTC).
 * Delegates to the jobs layer's `nextOccurrence` — the workflow layer never
 * reimplements schedule math.
 */
export function nextWorkflowOccurrence(
  schedule: JobSchedule,
  after: string,
): string | undefined {
  return nextOccurrence(schedule, after);
}

/**
 * Resolve a dot path against a signal object (e.g. `"memory.kind"` →
 * `signal["memory"]["kind"]`). Returns `undefined` for missing paths.
 * Deterministic and pure.
 */
export function resolveSignalPath(
  signal: Readonly<Record<string, unknown>>,
  path: string,
): unknown {
  let current: unknown = signal;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Evaluate a {@link WorkflowCondition} against a signal object.
 *
 * - `"eq"` / `"neq"`: deep equality against `value`.
 * - `"gt"` / `"gte"` / `"lt"` / `"lte"`: numeric comparison (`Date.parse` for
 *   strings, `Number` otherwise); a non-numeric value never satisfies the
 *   comparison.
 * - `"contains"`: the resolved value is a string containing `value`, or an
 *   array containing `value`.
 * - `"exists"`: the resolved value is not `undefined`.
 *
 * Never throws — a missing path simply fails the predicate. Deterministic.
 */
export function evaluateCondition(
  condition: WorkflowCondition,
  signal: Readonly<Record<string, unknown>>,
): boolean {
  const resolved = resolveSignalPath(signal, condition.field);
  if (condition.operator === "exists") return resolved !== undefined;
  if (resolved === undefined) return false;

  switch (condition.operator) {
    case "eq":
      return resolved === condition.value;
    case "neq":
      return resolved !== condition.value;
    case "gt":
      return compareNumeric(resolved, condition.value) > 0;
    case "gte":
      return compareNumeric(resolved, condition.value) >= 0;
    case "lt":
      return compareNumeric(resolved, condition.value) < 0;
    case "lte":
      return compareNumeric(resolved, condition.value) <= 0;
    case "contains":
      if (condition.value === undefined) return false;
      if (typeof resolved === "string") {
        return resolved.includes(String(condition.value));
      }
      if (Array.isArray(resolved)) {
        return resolved.some((entry) => entry === condition.value);
      }
      return false;
    default:
      return false;
  }
}

/** Numeric comparison helper for the ordering operators. */
function compareNumeric(resolved: unknown, value: unknown): number {
  const left = typeof resolved === "string" ? Date.parse(resolved) : Number(resolved);
  const right = typeof value === "string" ? Date.parse(value) : Number(value);
  if (Number.isNaN(left) || Number.isNaN(right)) return Number.NaN;
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Estimate the execution cost of a workflow: its explicit `costUnits` when
 * set, else the priority base cost. Deterministic and pure.
 */
export function estimateWorkflowCost(workflow: Workflow): number {
  return workflow.metadata.costUnits ?? PRIORITY_COST[workflow.priority];
}

/**
 * Build a lightweight summary projection of a workflow (see
 * `WorkflowSummary`).
 */
export function createWorkflowSummary(workflow: Workflow): WorkflowSummary {
  return {
    id: workflow.id,
    name: workflow.name,
    status: workflow.status,
    priority: workflow.priority,
    trigger: workflow.trigger.kind,
    createdAt: workflow.createdAt,
    ...(workflow.scheduledAt !== undefined ? { scheduledAt: workflow.scheduledAt } : {}),
    stepCount: workflow.steps.length,
    attempts: workflow.attempts,
    maxAttempts: workflow.maxAttempts,
    archived: workflow.archived,
    enabled: workflow.enabled,
    costEstimate: estimateWorkflowCost(workflow),
  };
}

/**
 * Build the run history of a workflow (see `WorkflowHistory`). Detached —
 * the returned executions array is new.
 */
export function createWorkflowHistory(workflow: Workflow): WorkflowHistory {
  return { workflowId: workflow.id, executions: [...workflow.executions] };
}

/**
 * Build a stable reference to a workflow (see `WorkflowReference`).
 */
export function createWorkflowReference(workflow: Workflow): WorkflowReference {
  return { workflowId: workflow.id, trigger: workflow.trigger.kind };
}

/** Detached copy of a workflow result. */
function cloneWorkflowResult(result: WorkflowResult): WorkflowResult {
  return {
    success: result.success,
    ...(result.output !== undefined ? { output: result.output } : {}),
    ...(result.message !== undefined ? { message: result.message } : {}),
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
  };
}

/** Detached copy of a trigger. */
function cloneTrigger(trigger: WorkflowTrigger): WorkflowTrigger {
  return {
    kind: trigger.kind,
    ...(trigger.schedule !== undefined ? { schedule: cloneSchedule(trigger.schedule) } : {}),
    ...(trigger.event !== undefined ? { event: trigger.event } : {}),
    ...(trigger.conversationId !== undefined ? { conversationId: trigger.conversationId } : {}),
    ...(trigger.memoryId !== undefined ? { memoryId: trigger.memoryId } : {}),
    ...(trigger.digestId !== undefined ? { digestId: trigger.digestId } : {}),
    ...(trigger.jobId !== undefined ? { jobId: trigger.jobId } : {}),
    ...(trigger.actionId !== undefined ? { actionId: trigger.actionId } : {}),
    ...(trigger.toolId !== undefined ? { toolId: trigger.toolId } : {}),
  };
}

/** Re-exported convenience: whether a schedule repeats (jobs layer). */
export { isRecurringSchedule } from "@/lib/jobs/types";

/** Detached copy of a jobs-layer schedule. */
function cloneSchedule(schedule: JobSchedule): JobSchedule {
  return {
    ...(schedule.at !== undefined ? { at: schedule.at } : {}),
    ...(schedule.everyMs !== undefined ? { everyMs: schedule.everyMs } : {}),
    ...(schedule.startsAt !== undefined ? { startsAt: schedule.startsAt } : {}),
  };
}

/**
 * Detached copy of an optional schedule, applying the jobs-layer default
 * (see `createJob`): a recurring schedule without `startsAt` is defaulted to
 * `createdAt`, so recurring workflows always carry a concrete `scheduledAt`
 * and can be rescheduled by `rescheduleWorkflow`.
 */
function cloneScheduleWithDefaults(
  schedule: JobSchedule | undefined,
  createdAt: string,
): JobSchedule | undefined {
  if (schedule === undefined) return undefined;
  if (schedule.everyMs !== undefined && schedule.startsAt === undefined) {
    return { ...cloneSchedule(schedule), startsAt: createdAt };
  }
  return cloneSchedule(schedule);
}
