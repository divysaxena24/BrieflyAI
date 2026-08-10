/**
 * AI Actions — immutable domain models.
 *
 * Step 1 of the AI Actions framework: the pure, readonly data model for
 * actions plus the pure helper functions that construct, clone, freeze,
 * touch, schedule, and measure them.
 *
 * No services, no LLM, no database, no timers, and no side effects live here
 * — only data and pure functions. Every function is deterministic: identical
 * inputs always produce identical outputs, and caller-supplied
 * objects/arrays are never referenced or mutated (they are copied on entry,
 * and the returned structures are detached).
 *
 * Timestamps are always supplied by the caller (no `Date.now()`) so every
 * operation stays pure and reproducible.
 */

/** Lifecycle state of an action. */
export type ActionStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped";

/** Execution priority of an action — drives plan ordering. */
export type ActionPriority = "low" | "normal" | "high" | "critical";

/**
 * Semantic type of an action.
 *
 * `custom` is the escape hatch for application-defined action types; the
 * built-in types map onto the existing production engines (see
 * `lib/actions/builtin.ts`). An action whose type has no registered handler
 * fails structurally (`unknown_action`) — it never throws.
 */
export type ActionType =
  | "search_gmail"
  | "search_calendar"
  | "search_drive"
  | "search_github"
  | "create_memory"
  | "update_conversation"
  | "generate_digest"
  | "run_job"
  | "execute_tool_plan"
  | "custom";

/** How an action was launched. */
export type ActionTrigger = "manual" | "scheduled" | "recurring" | "intent" | "startup" | "shutdown";

/** Default status assigned by `createAction` when none is provided. */
export const DEFAULT_ACTION_STATUS: ActionStatus = "pending";

/** Default priority assigned by `createAction` when none is provided. */
export const DEFAULT_ACTION_PRIORITY: ActionPriority = "normal";

/** Default trigger assigned by `createAction` when none is provided. */
export const DEFAULT_ACTION_TRIGGER: ActionTrigger = "manual";

/** Default attempt budget assigned by `createAction` (no retries unless configured). */
export const DEFAULT_ACTION_MAX_ATTEMPTS = 1;

/** Default archived flag assigned by `createAction`. */
export const DEFAULT_ACTION_ARCHIVED = false;

/**
 * Deterministic ordering rank of each priority — higher runs first.
 * `critical` (3) > `high` (2) > `normal` (1) > `low` (0).
 */
export const PRIORITY_RANK: Readonly<Record<ActionPriority, number>> = Object.freeze({
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
});

/**
 * Base execution-cost heuristic of each priority, used by
 * `estimateActionCost` when an action carries no explicit `costUnits`.
 */
export const PRIORITY_COST: Readonly<Record<ActionPriority, number>> = Object.freeze({
  low: 1,
  normal: 2,
  high: 4,
  critical: 8,
});

/** Structured error attached to a failed or cancelled action. */
export interface ActionError {
  /** Stable machine-readable code, e.g. "timeout", "handler_error". */
  readonly code: string;
  /** Human-readable detail. */
  readonly message: string;
}

/** Structured outcome of a completed action run. */
export interface ActionResult {
  /** True when the run produced a useful output. */
  readonly success: boolean;
  /** The action's output on success. */
  readonly output?: unknown;
  /** Optional human-readable note about the run. */
  readonly message?: string;
  /** Wall-clock duration of the run in milliseconds. */
  readonly durationMs?: number;
}

/**
 * A single recorded execution of an action.
 *
 * One execution is appended when an action starts and finalized (status,
 * finishedAt, error/result, durationMs) when it settles.
 */
export interface ActionExecution {
  /** Stable execution id; deterministic when derived by `createActionExecution`. */
  readonly id: string;
  /** The action this execution belongs to. */
  readonly actionId: string;
  /** 1-based attempt number within the action's run. */
  readonly attempt: number;
  /** The execution's lifecycle state. */
  readonly status: ActionStatus;
  /** ISO-8601 UTC timestamp of the attempt's start. */
  readonly startedAt: string;
  /** ISO-8601 UTC timestamp of the attempt's settlement, when settled. */
  readonly finishedAt?: string;
  /** Structured failure/cancellation detail, when not successful. */
  readonly error?: ActionError;
  /** Structured outcome, when the attempt completed. */
  readonly result?: ActionResult;
  /** Wall-clock duration of the attempt in milliseconds, when settled. */
  readonly durationMs?: number;
}

/**
 * Structured metadata of an action.
 *
 * `timeoutMs`, `retryDelayMs`, and `costUnits` are execution hints honored by
 * the executor and the pure cost estimator; `tags` are stable labels.
 */
export interface ActionMetadata {
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
 * An immutable action.
 *
 * `status` drives schedulability; `input` is the validated payload handed to
 * the action's handler; `dependsOn` lists action ids that must complete
 * successfully before this action may run (planner-produced ordering);
 * `attempts` counts started runs; `executions` is the full run history.
 */
export interface Action {
  /** Stable action id; deterministic when derived by `createAction`. */
  readonly id: string;
  /** Human-readable action name. */
  readonly name: string;
  readonly type: ActionType;
  readonly status: ActionStatus;
  readonly priority: ActionPriority;
  readonly trigger: ActionTrigger;
  /** The action's input payload (validated by its handler at execution). */
  readonly input?: Readonly<Record<string, unknown>>;
  /** Action ids this action depends on (execution-order constraint). */
  readonly dependsOn: readonly string[];
  /** Number of times the action has been started. */
  readonly attempts: number;
  /** Total attempt budget (retries are `maxAttempts − 1`). */
  readonly maxAttempts: number;
  /** ISO-8601 UTC timestamp of the action's creation. */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the next/only scheduled run. */
  readonly scheduledAt?: string;
  /** ISO-8601 UTC timestamp of the most recent start. */
  readonly startedAt?: string;
  /** ISO-8601 UTC timestamp of the most recent completion. */
  readonly completedAt?: string;
  /** When true, the action is excluded from scheduling (see `archiveAction`). */
  readonly archived: boolean;
  /** Structured failure/cancellation detail of the most recent run. */
  readonly error?: ActionError;
  /** Structured outcome of the most recent completed run. */
  readonly result?: ActionResult;
  readonly metadata: ActionMetadata;
  /** Run history, oldest first. */
  readonly executions: readonly ActionExecution[];
  /** Conversation this action was planned from, when applicable. */
  readonly conversationId?: string;
  /** Memory this action operates on / produced, when applicable. */
  readonly memoryId?: string;
  /** Job this action targets (run_job), when applicable. */
  readonly jobId?: string;
}

/**
 * Lightweight projection of an action for list/overview views.
 */
export interface ActionSummary {
  readonly id: string;
  readonly name: string;
  readonly type: ActionType;
  readonly status: ActionStatus;
  readonly priority: ActionPriority;
  readonly trigger: ActionTrigger;
  /** ISO-8601 UTC timestamp of the action's creation. */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the next/only scheduled run. */
  readonly scheduledAt?: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly archived: boolean;
  /** Estimated execution cost (see `estimateActionCost`). */
  readonly costEstimate: number;
}

/**
 * The run history of a single action — the dedupe/citation key of the action
 * layer.
 */
export interface ActionHistory {
  readonly actionId: string;
  readonly executions: readonly ActionExecution[];
}

/**
 * A stable reference to an action — the lightweight handle used to address
 * an action without carrying its full state.
 */
export interface ActionReference {
  readonly actionId: string;
  /** The action type, when known. */
  readonly type?: ActionType;
  /** The trigger that launched the action, when known. */
  readonly trigger?: ActionTrigger;
}

/**
 * Runtime context handed to an action handler at execution time.
 *
 * Carries the current action (in its `running` state), the 1-based attempt
 * number, the executor's cancellation signal (a cooperative handler may stop
 * early), and the injected current time — so handlers stay deterministic.
 * `userId` is forwarded from the surrounding plan when the planner knew it.
 */
export interface ActionContext {
  /** The action being executed (status `"running"`). */
  readonly action: Action;
  /** 1-based attempt number within the action's run. */
  readonly attempt: number;
  /** Abort signal observed by the executor; handlers may honor it. */
  readonly signal?: AbortSignal;
  /** ISO-8601 UTC timestamp of the run start (injected, deterministic). */
  readonly now: string;
  /** Application-level user id, when known from the surrounding plan. */
  readonly userId?: string;
}

/**
 * Deterministic 32-bit FNV-1a hash of `value`, rendered as lowercase hex.
 * Used to derive stable action/execution ids from an action's own contents,
 * so `createAction`/`createActionExecution` stay pure and deterministic.
 * (The job/digest/memory/conversation layers own sibling hashes; this layer
 * follows the same per-layer convention.)
 */
export function hashAction(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Deterministic action id derived from the action's own contents. */
function actionIdFor(
  name: string,
  type: ActionType,
  trigger: ActionTrigger,
  priority: ActionPriority,
  createdAt: string,
  scheduledAt: string | undefined,
): string {
  return `action-${hashAction(`${name}:${type}:${trigger}:${priority}:${createdAt}:${scheduledAt ?? ""}`)}`;
}

/** Options accepted by {@link createAction}. */
export interface CreateActionInput {
  /** Explicit id; when omitted, one is derived deterministically. */
  readonly id?: string;
  readonly name: string;
  readonly type: ActionType;
  readonly status?: ActionStatus;
  readonly priority?: ActionPriority;
  readonly trigger?: ActionTrigger;
  /** The action's input payload (validated by its handler at execution). */
  readonly input?: Readonly<Record<string, unknown>>;
  /** Action ids this action depends on (execution-order constraint). */
  readonly dependsOn?: readonly string[];
  /** Attempt budget; defaults to 1 (no retries). */
  readonly maxAttempts?: number;
  /** Started-run count; defaults to 0. */
  readonly attempts?: number;
  /** ISO-8601 UTC timestamp of the action's creation. */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the next/only scheduled run. */
  readonly scheduledAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly archived?: boolean;
  readonly error?: ActionError;
  readonly result?: ActionResult;
  readonly metadata?: Partial<ActionMetadata>;
  readonly executions?: readonly ActionExecution[];
  readonly conversationId?: string;
  readonly memoryId?: string;
  readonly jobId?: string;
}

/**
 * Build a new immutable action.
 *
 * - `id` defaults to a deterministic hash of name + type + trigger +
 *   priority + createdAt + scheduledAt. Derived ids are stable but not
 *   guaranteed unique across actions with identical inputs; callers that
 *   need uniqueness should pass an explicit `id`.
 * - `status` defaults to `"pending"`, `priority` to `"normal"`, `trigger` to
 *   `"manual"`, `maxAttempts` to 1, `archived` to false, `dependsOn` to `[]`,
 *   and `metadata.tags` to `[]`.
 * - `input` is copied as a new record (nested values shared by reference);
 *   `dependsOn`, `tags`, and `executions` are copied as new arrays. The
 *   returned object is new and detached from all inputs.
 */
export function createAction(input: CreateActionInput): Action {
  const metadata: ActionMetadata = {
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
      actionIdFor(
        input.name,
        input.type,
        input.trigger ?? DEFAULT_ACTION_TRIGGER,
        input.priority ?? DEFAULT_ACTION_PRIORITY,
        input.createdAt,
        input.scheduledAt,
      ),
    name: input.name,
    type: input.type,
    status: input.status ?? DEFAULT_ACTION_STATUS,
    priority: input.priority ?? DEFAULT_ACTION_PRIORITY,
    trigger: input.trigger ?? DEFAULT_ACTION_TRIGGER,
    ...(input.input !== undefined ? { input: { ...input.input } } : {}),
    dependsOn: input.dependsOn !== undefined ? [...input.dependsOn] : [],
    attempts: input.attempts ?? 0,
    maxAttempts: input.maxAttempts ?? DEFAULT_ACTION_MAX_ATTEMPTS,
    createdAt: input.createdAt,
    ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    archived: input.archived ?? DEFAULT_ACTION_ARCHIVED,
    ...(input.error !== undefined ? { error: { ...input.error } } : {}),
    ...(input.result !== undefined
      ? {
          result: {
            success: input.result.success,
            ...(input.result.output !== undefined ? { output: input.result.output } : {}),
            ...(input.result.message !== undefined ? { message: input.result.message } : {}),
            ...(input.result.durationMs !== undefined
              ? { durationMs: input.result.durationMs }
              : {}),
          },
        }
      : {}),
    metadata,
    executions: input.executions !== undefined ? [...input.executions] : [],
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    ...(input.memoryId !== undefined ? { memoryId: input.memoryId } : {}),
    ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
  };
}

/** Options accepted by {@link createActionExecution}. */
export interface CreateActionExecutionInput {
  /** Explicit id; when omitted, one is derived deterministically. */
  readonly id?: string;
  readonly actionId: string;
  /** 1-based attempt number within the action's run. */
  readonly attempt: number;
  readonly status: ActionStatus;
  /** ISO-8601 UTC timestamp of the attempt's start. */
  readonly startedAt: string;
  /** ISO-8601 UTC timestamp of the attempt's settlement, when settled. */
  readonly finishedAt?: string;
  readonly error?: ActionError;
  readonly result?: ActionResult;
  /** Wall-clock duration of the attempt in milliseconds, when settled. */
  readonly durationMs?: number;
}

/**
 * Build a new immutable execution record.
 *
 * `id` defaults to a deterministic hash of actionId + attempt + startedAt +
 * status. `error`/`result` are copied as new records; the returned object is
 * new and detached from all inputs.
 */
export function createActionExecution(input: CreateActionExecutionInput): ActionExecution {
  return {
    id:
      input.id ??
      `exec-action-${hashAction(`${input.actionId}:${input.attempt}:${input.startedAt}:${input.status}`)}`,
    actionId: input.actionId,
    attempt: input.attempt,
    status: input.status,
    startedAt: input.startedAt,
    ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
    ...(input.error !== undefined ? { error: { ...input.error } } : {}),
    ...(input.result !== undefined
      ? {
          result: {
            success: input.result.success,
            ...(input.result.output !== undefined ? { output: input.result.output } : {}),
            ...(input.result.message !== undefined ? { message: input.result.message } : {}),
            ...(input.result.durationMs !== undefined
              ? { durationMs: input.result.durationMs }
              : {}),
          },
        }
      : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  };
}

/**
 * A partial patch applied by {@link touchAction} (and the repository's
 * `update`).
 *
 * Keys present in the patch are applied; missing keys are preserved. A `null`
 * value clears the corresponding optional field.
 */
export type ActionPatch = Partial<{
  name: string;
  type: ActionType;
  status: ActionStatus;
  priority: ActionPriority;
  trigger: ActionTrigger;
  input: Readonly<Record<string, unknown>> | null;
  dependsOn: readonly string[];
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  archived: boolean;
  error: ActionError | null;
  result: ActionResult | null;
  tags: readonly string[];
  timeoutMs: number | null;
  retryDelayMs: number | null;
  costUnits: number | null;
  executions: readonly ActionExecution[];
  conversationId: string | null;
  memoryId: string | null;
  jobId: string | null;
}>;

/**
 * Return the successor action with the patch applied.
 *
 * Missing patch keys are preserved; `input`, `dependsOn`, `tags`, and
 * `executions` are copied; a `null` value clears an optional field.
 * Deterministic; the input is never mutated.
 */
export function touchAction(action: Action, patch: ActionPatch): Action {
  const metadata: ActionMetadata = {
    tags: patch.tags !== undefined ? [...patch.tags] : [...action.metadata.tags],
    ...(patch.timeoutMs !== undefined
      ? patch.timeoutMs !== null
        ? { timeoutMs: patch.timeoutMs }
        : {}
      : action.metadata.timeoutMs !== undefined
        ? { timeoutMs: action.metadata.timeoutMs }
        : {}),
    ...(patch.retryDelayMs !== undefined
      ? patch.retryDelayMs !== null
        ? { retryDelayMs: patch.retryDelayMs }
        : {}
      : action.metadata.retryDelayMs !== undefined
        ? { retryDelayMs: action.metadata.retryDelayMs }
        : {}),
    ...(patch.costUnits !== undefined
      ? patch.costUnits !== null
        ? { costUnits: patch.costUnits }
        : {}
      : action.metadata.costUnits !== undefined
        ? { costUnits: action.metadata.costUnits }
        : {}),
  };

  return {
    id: action.id,
    name: patch.name ?? action.name,
    type: patch.type ?? action.type,
    status: patch.status ?? action.status,
    priority: patch.priority ?? action.priority,
    trigger: patch.trigger ?? action.trigger,
    ...(patch.input !== undefined
      ? patch.input !== null
        ? { input: { ...patch.input } }
        : {}
      : action.input !== undefined
        ? { input: { ...action.input } }
        : {}),
    dependsOn: patch.dependsOn !== undefined ? [...patch.dependsOn] : [...action.dependsOn],
    attempts: patch.attempts ?? action.attempts,
    maxAttempts: patch.maxAttempts ?? action.maxAttempts,
    createdAt: patch.createdAt ?? action.createdAt,
    ...(patch.scheduledAt !== undefined
      ? patch.scheduledAt !== null
        ? { scheduledAt: patch.scheduledAt }
        : {}
      : action.scheduledAt !== undefined
        ? { scheduledAt: action.scheduledAt }
        : {}),
    ...(patch.startedAt !== undefined
      ? patch.startedAt !== null
        ? { startedAt: patch.startedAt }
        : {}
      : action.startedAt !== undefined
        ? { startedAt: action.startedAt }
        : {}),
    ...(patch.completedAt !== undefined
      ? patch.completedAt !== null
        ? { completedAt: patch.completedAt }
        : {}
      : action.completedAt !== undefined
        ? { completedAt: action.completedAt }
        : {}),
    archived: patch.archived ?? action.archived,
    ...(patch.error !== undefined
      ? patch.error !== null
        ? { error: { ...patch.error } }
        : {}
      : action.error !== undefined
        ? { error: { ...action.error } }
        : {}),
    ...(patch.result !== undefined
      ? patch.result !== null
        ? { result: cloneActionResult(patch.result) }
        : {}
      : action.result !== undefined
        ? { result: cloneActionResult(action.result) }
        : {}),
    metadata,
    executions: patch.executions !== undefined ? [...patch.executions] : [...action.executions],
    ...(patch.conversationId !== undefined
      ? patch.conversationId !== null
        ? { conversationId: patch.conversationId }
        : {}
      : action.conversationId !== undefined
        ? { conversationId: action.conversationId }
        : {}),
    ...(patch.memoryId !== undefined
      ? patch.memoryId !== null
        ? { memoryId: patch.memoryId }
        : {}
      : action.memoryId !== undefined
        ? { memoryId: action.memoryId }
        : {}),
    ...(patch.jobId !== undefined
      ? patch.jobId !== null
        ? { jobId: patch.jobId }
        : {}
      : action.jobId !== undefined
        ? { jobId: action.jobId }
        : {}),
  };
}

/** Detached copy of an action result. */
function cloneActionResult(result: ActionResult): ActionResult {
  return {
    success: result.success,
    ...(result.output !== undefined ? { output: result.output } : {}),
    ...(result.message !== undefined ? { message: result.message } : {}),
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
  };
}

/**
 * Deep-freeze an action in place and return it.
 *
 * Freezes the action, its metadata (and `tags`), its input record, its
 * error/result records, the executions array, and every execution (and their
 * nested error/result records). Idempotent: freezing an already frozen action
 * is a no-op.
 */
export function freezeAction(action: Action): Action {
  if (action.input !== undefined) Object.freeze(action.input);
  Object.freeze(action.metadata.tags);
  Object.freeze(action.metadata);
  if (action.error !== undefined) Object.freeze(action.error);
  if (action.result !== undefined) Object.freeze(action.result);
  for (const execution of action.executions) {
    if (execution.error !== undefined) Object.freeze(execution.error);
    if (execution.result !== undefined) Object.freeze(execution.result);
    Object.freeze(execution);
  }
  Object.freeze(action.executions);
  Object.freeze(action.dependsOn);
  Object.freeze(action);
  return action;
}

/**
 * Return a deep, detached copy of an action.
 *
 * Every object is new — the action, its metadata (and `tags`), its input
 * record, its error/result records, the executions array, and each execution
 * (and their nested records) — so mutating the clone's own structure can
 * never affect the source and vice versa. Nested values inside an input or a
 * result's `output` are shared by reference. The clone is not frozen (call
 * `freezeAction` to freeze it). Values, including optional fields, are
 * preserved exactly.
 */
export function cloneAction(action: Action): Action {
  return touchAction(action, {
    executions: action.executions.map((execution) =>
      createActionExecution({
        id: execution.id,
        actionId: execution.actionId,
        attempt: execution.attempt,
        status: execution.status,
        startedAt: execution.startedAt,
        ...(execution.finishedAt !== undefined ? { finishedAt: execution.finishedAt } : {}),
        ...(execution.error !== undefined ? { error: { ...execution.error } } : {}),
        ...(execution.result !== undefined ? { result: cloneActionResult(execution.result) } : {}),
        ...(execution.durationMs !== undefined ? { durationMs: execution.durationMs } : {}),
      }),
    ),
  });
}

/**
 * Whether an action is due to run at `now`.
 *
 * A pending, non-archived action is due when:
 * - it has no schedule (manual/intent/startup/shutdown actions are runnable
 *   whenever they are pending), or
 * - its `scheduledAt` is defined and at or before `now`.
 *
 * Deterministic — `now` is supplied by the caller.
 */
export function isActionDue(action: Action, now: string): boolean {
  if (action.status !== "pending" || action.archived) return false;
  if (action.scheduledAt === undefined) return true;
  return Date.parse(action.scheduledAt) <= Date.parse(now);
}

/**
 * Whether an action is runnable at `now` (see {@link isActionDue}).
 *
 * `isActionRunnable` is the schedulability predicate used by the repository
 * and the manager; identical to `isActionDue`.
 */
export function isActionRunnable(action: Action, now: string): boolean {
  return isActionDue(action, now);
}

/**
 * Estimate the execution cost of an action: its explicit `costUnits` when
 * set, else the priority base cost. Deterministic and pure.
 */
export function estimateActionCost(action: Action): number {
  return action.metadata.costUnits ?? PRIORITY_COST[action.priority];
}

/**
 * Build a lightweight summary projection of an action (see `ActionSummary`).
 */
export function createActionSummary(action: Action): ActionSummary {
  return {
    id: action.id,
    name: action.name,
    type: action.type,
    status: action.status,
    priority: action.priority,
    trigger: action.trigger,
    createdAt: action.createdAt,
    ...(action.scheduledAt !== undefined ? { scheduledAt: action.scheduledAt } : {}),
    attempts: action.attempts,
    maxAttempts: action.maxAttempts,
    archived: action.archived,
    costEstimate: estimateActionCost(action),
  };
}

/**
 * Build the run history of an action (see `ActionHistory`). Detached — the
 * returned executions array is new.
 */
export function createActionHistory(action: Action): ActionHistory {
  return { actionId: action.id, executions: [...action.executions] };
}

/**
 * Build a stable reference to an action (see `ActionReference`).
 */
export function createActionReference(action: Action): ActionReference {
  return { actionId: action.id, type: action.type, trigger: action.trigger };
}
