/**
 * Background Worker Infrastructure — immutable domain models (Phase 6B STEP 2).
 *
 * Every model is readonly and frozen; every id is deterministic (derived via
 * the shared FNV-1a `hashString` from `@/lib/hash` — never duplicated); every
 * timestamp is caller-supplied (no `Date.now()`, no `Math.random()`). Helpers
 * are pure: constructors, deep clone, deep freeze, deterministic ids, hashes,
 * summaries, references, statistics and snapshots.
 *
 * The layer is dependency-injected end to end: no worker module constructs an
 * engine or a clock.
 */

import { hashString } from "@/lib/hash";

/** Priority of a worker or task (deterministic ordering key). */
export type WorkerPriority = "low" | "normal" | "high" | "critical";

/** Canonical priority ranks (higher = more important). */
export const PRIORITY_RANK: Readonly<Record<WorkerPriority, number>> = Object.freeze({
  low: 1,
  normal: 2,
  high: 3,
  critical: 4,
});

/** Lifecycle status of a worker. */
export type WorkerStatus =
  | "registered"
  | "starting"
  | "running"
  | "idle"
  | "busy"
  | "paused"
  | "stopping"
  | "stopped"
  | "failed"
  | "removed";

/** Runtime state of a worker (derived view). */
export type WorkerState =
  | "running"
  | "idle"
  | "busy"
  | "paused"
  | "stopped"
  | "failed"
  | "dead";

/** The kinds of tasks a worker executes. */
export type WorkerTaskKind = "job" | "workflow" | "action" | "digest" | "tool" | "custom";

/** Lifecycle status of a task. */
export type WorkerTaskStatus =
  | "pending"
  | "scheduled"
  | "delayed"
  | "leased"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "retrying"
  | "dead";

/** The kinds of queues in the worker layer. */
export type WorkerQueueKind = "priority" | "fifo" | "retry" | "scheduled" | "delayed" | "deadLetter";

/** Lifecycle signals a worker can receive. */
export type WorkerSignalKind = "start" | "pause" | "resume" | "stop" | "restart" | "heartbeat";

/** Event types emitted by the worker layer (for diagnostics/supervision). */
export type WorkerEventType =
  | "registered"
  | "started"
  | "paused"
  | "resumed"
  | "stopped"
  | "restarted"
  | "heartbeat"
  | "task.leased"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.retried"
  | "task.dead"
  | "lease.expired"
  | "worker.failed"
  | "worker.recovered"
  | "pool.scaled"
  | "supervised";

/** Health status of a worker. */
export type WorkerHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

/** A structured worker/task failure. */
export interface WorkerError {
  readonly code: string;
  readonly message: string;
  /** When true, a retry is likely to succeed (drives the retry policy). */
  readonly retryable?: boolean;
}

/** Retry policy for a task. */
export interface WorkerRetryPolicy {
  /** Total retries after the first attempt (0 = no retries unless configured). */
  readonly maxRetries: number;
  /** Base delay between attempts, in milliseconds. */
  readonly backoffMs: number;
  /** When defined, only these error codes are retried. */
  readonly retryableCodes?: readonly string[];
  /** Cap on the effective backoff (backoff never exceeds this). */
  readonly maxDelayMs?: number;
}

/** Dependency edge between tasks. */
export interface WorkerDependency {
  readonly taskId: string;
  /** Task ids that must settle before this task runs. */
  readonly dependsOn: readonly string[];
  /** hard = must complete; soft = must settle (complete or cancelled). */
  readonly kind: "hard" | "soft";
}

/** A task's schedule (pure data — no cron engine lives here). */
export interface WorkerSchedule {
  /** Recurrence interval in milliseconds. */
  readonly everyMs?: number;
  /** One-shot due timestamp. */
  readonly at?: string;
  /** Opaque cron expression (interpreted by the application, not this layer). */
  readonly cron?: string;
}

/** Task payload discriminated by kind (engine-specific fields stay `unknown`). */
export interface JobTaskPayload {
  readonly jobId: string;
}
export interface WorkflowTaskPayload {
  readonly workflowId: string;
  /** Opaque trigger event kind forwarded to the workflow engine. */
  readonly event?: string;
}
export interface ActionTaskPayload {
  readonly text: string;
  readonly userId: string;
  readonly requests: readonly unknown[];
}
export interface DigestTaskPayload {
  readonly template: string;
  readonly userId: string;
}
export interface ToolTaskPayload {
  readonly planId: string;
  readonly steps: readonly unknown[];
}
export interface CustomTaskPayload {
  readonly input: Readonly<Record<string, unknown>>;
}

export type WorkerTaskPayload =
  | ({ readonly kind: "job" } & JobTaskPayload)
  | ({ readonly kind: "workflow" } & WorkflowTaskPayload)
  | ({ readonly kind: "action" } & ActionTaskPayload)
  | ({ readonly kind: "digest" } & DigestTaskPayload)
  | ({ readonly kind: "tool" } & ToolTaskPayload)
  | ({ readonly kind: "custom" } & CustomTaskPayload);

/** Metadata attached to workers and tasks. */
export interface WorkerMetadata {
  readonly tags: readonly string[];
}

/** Worker capacity: concurrent slots and scheduling weight. */
export interface WorkerCapacity {
  /** Maximum concurrent tasks this worker can hold. */
  readonly maxConcurrent: number;
  /** Currently occupied slots (derived from leases). */
  readonly busy: number;
  /** Scheduling weight for fair/weighted strategies. */
  readonly weight: number;
}

/** Hard limits applied to a worker. */
export interface WorkerLimits {
  /** Maximum concurrent tasks (bounds capacity). */
  readonly maxTasks: number;
  /** Maximum automatic restarts before escalation. */
  readonly maxRestarts: number;
  /** Default lease duration in milliseconds. */
  readonly leaseDurationMs: number;
  /** Heartbeat timeout in milliseconds (dead-worker detection). */
  readonly heartbeatTimeoutMs: number;
}

/** Health record of a worker. */
export interface WorkerHealth {
  readonly status: WorkerHealthStatus;
  /** Score 0..1 (1 = fully healthy); derived deterministically. */
  readonly score: number;
  /** Most recent heartbeat timestamp, when any. */
  readonly lastHeartbeatAt?: string;
}

/** Registration record of a worker into a pool. */
export interface WorkerRegistration {
  readonly workerId: string;
  /** ISO-8601 UTC timestamp of the registration. */
  readonly at: string;
  readonly pool: string;
  readonly capabilities: readonly string[];
}

/** A heartbeat signal. */
export interface WorkerHeartbeat {
  readonly workerId: string;
  readonly at: string;
  readonly state?: WorkerState;
  readonly health?: WorkerHealth;
}

/** A lease granting a worker exclusive ownership of a task. */
export interface WorkerLease {
  readonly id: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly renewedAt?: string;
  readonly status: "active" | "released" | "expired" | "completed" | "failed" | "cancelled";
}

/** A reservation (capacity slot held for a task). */
export interface WorkerReservation {
  readonly id: string;
  readonly workerId: string;
  readonly taskId: string;
  readonly reservedAt: string;
  readonly expiresAt: string;
  readonly slot: number;
}

/** A committed allocation of a task to a worker slot. */
export interface WorkerAllocation {
  readonly id: string;
  readonly workerId: string;
  readonly taskId: string;
  readonly allocatedAt: string;
  readonly slot: number;
  readonly leaseId: string;
}

/** One run of a task on a worker. */
export interface WorkerExecution {
  readonly id: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly attempt: number;
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly output?: unknown;
  readonly error?: WorkerError;
  /** Wall-clock duration of the run in milliseconds. */
  readonly durationMs?: number;
}

/** Structured outcome of executing a task. */
export interface WorkerExecutionResult {
  readonly taskId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly output?: unknown;
  readonly error?: WorkerError;
  /** Wall-clock duration of the whole run in milliseconds. */
  readonly durationMs: number;
  readonly attemptsMade: number;
}

/** A history entry (lifecycle transition). */
export interface WorkerHistoryEntry {
  readonly at: string;
  readonly kind: WorkerEventType | "state.change";
  readonly detail?: string;
}

/** An immutable worker. */
export interface Worker {
  readonly id: string;
  readonly name: string;
  readonly pool: string;
  readonly status: WorkerStatus;
  readonly state: WorkerState;
  readonly priority: WorkerPriority;
  readonly capabilities: readonly string[];
  readonly capacity: WorkerCapacity;
  readonly limits: WorkerLimits;
  readonly registration: WorkerRegistration;
  readonly lastHeartbeatAt?: string;
  readonly health: WorkerHealth;
  /** Consecutive failure count (drives recovery/escalation). */
  readonly failures: number;
  readonly restartCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly stoppedAt?: string;
  readonly pausedAt?: string;
  readonly history: readonly WorkerHistoryEntry[];
  readonly metadata: WorkerMetadata;
}

/** An immutable worker pool. */
export interface WorkerPool {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly workerIds: readonly string[];
  readonly createdAt: string;
}

/** An immutable worker task. */
export interface WorkerTask {
  readonly id: string;
  readonly name: string;
  readonly kind: WorkerTaskKind;
  readonly priority: WorkerPriority;
  readonly status: WorkerTaskStatus;
  readonly attempts: number;
  /** Total attempt budget (retries are `maxAttempts − 1`). */
  readonly maxAttempts: number;
  readonly dependencies: readonly string[];
  readonly payload: WorkerTaskPayload;
  readonly retryPolicy?: WorkerRetryPolicy;
  readonly schedule?: WorkerSchedule;
  readonly timeoutMs?: number;
  readonly metadata: WorkerMetadata;
  readonly createdAt: string;
  readonly scheduledAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: WorkerError;
  readonly result?: WorkerExecutionResult;
  readonly archived: boolean;
  readonly history: readonly WorkerHistoryEntry[];
}

/** A queue item (task reference inside a queue). */
export interface WorkerQueueItem {
  readonly id: string;
  readonly taskId: string;
  readonly kind: WorkerQueueKind;
  readonly priority: WorkerPriority;
  readonly status: "pending" | "scheduled" | "delayed" | "leased" | "retrying" | "dead";
  readonly enqueuedAt: string;
  /** When due (delay/retry/scheduled queues). */
  readonly dequeueAt?: string;
  readonly attempt: number;
}

/** Lightweight queue model (snapshot view). */
export interface WorkerQueue {
  readonly id: string;
  readonly name: string;
  readonly kind: WorkerQueueKind;
  readonly capacity: number;
  readonly itemIds: readonly string[];
  readonly createdAt: string;
}

/** A batch of tasks scheduled/executed together. */
export interface WorkerBatch {
  readonly id: string;
  readonly taskIds: readonly string[];
  readonly createdAt: string;
  readonly status: "pending" | "running" | "completed" | "failed" | "cancelled";
}

/** Aggregated worker/task counters. */
export interface WorkerStatistics {
  readonly workers: {
    readonly registered: number;
    readonly active: number;
    readonly idle: number;
    readonly busy: number;
    readonly paused: number;
    readonly stopped: number;
    readonly failed: number;
    readonly dead: number;
  };
  readonly tasks: {
    readonly pending: number;
    readonly scheduled: number;
    readonly delayed: number;
    readonly leased: number;
    readonly running: number;
    readonly completed: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly retrying: number;
    readonly dead: number;
  };
  readonly leases: { readonly active: number; readonly expired: number; readonly total: number };
}

/** Raw metrics accumulator for a worker or pool. */
export interface WorkerMetrics {
  readonly tasksCompleted: number;
  readonly tasksFailed: number;
  readonly tasksCancelled: number;
  readonly tasksRetried: number;
  readonly totalRuns: number;
  /** Sum of wall-clock durations in milliseconds. */
  readonly totalDurationMs: number;
  readonly queueDepth: number;
}

/** Lightweight projection of a worker for overview views. */
export interface WorkerSummary {
  readonly id: string;
  readonly name: string;
  readonly pool: string;
  readonly status: WorkerStatus;
  readonly state: WorkerState;
  readonly priority: WorkerPriority;
  readonly capacity: WorkerCapacity;
  readonly health: WorkerHealth;
  readonly lastHeartbeatAt?: string;
}

/** Stable reference to a worker/task/pool. */
export interface WorkerReference {
  readonly id: string;
  readonly kind: "worker" | "task" | "pool";
  readonly name: string;
}

/** A point-in-time snapshot of the worker layer. */
export interface WorkerSnapshot {
  readonly at: string;
  readonly workers: readonly Worker[];
  readonly tasks: readonly WorkerTask[];
  readonly pools: readonly WorkerPool[];
  readonly leases: readonly WorkerLease[];
  readonly statistics: WorkerStatistics;
}

/** Global worker configuration (dependency-injected defaults). */
export interface WorkerConfiguration {
  readonly heartbeatIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly maxRestarts: number;
  readonly maxTaskAttempts: number;
  readonly capacity: WorkerCapacity;
  readonly limits: WorkerLimits;
  readonly retryPolicy: WorkerRetryPolicy;
  readonly supervisorIntervalMs: number;
}

/** Execution context handed to a task handler. */
export interface WorkerContext {
  readonly workerId: string;
  readonly taskId: string;
  readonly attempt: number;
  /** ISO-8601 UTC timestamp of the run (injected). */
  readonly now: string;
  /** Whole-run cancellation signal. */
  readonly signal?: AbortSignal;
  readonly config?: WorkerConfiguration;
}

/** A lifecycle signal directed at a worker. */
export interface WorkerSignal {
  readonly id: string;
  readonly kind: WorkerSignalKind;
  readonly workerId: string;
  readonly at: string;
  readonly reason?: string;
}

/** A worker-layer event (diagnostics/supervision). */
export interface WorkerEvent {
  readonly id: string;
  readonly type: WorkerEventType;
  readonly workerId?: string;
  readonly taskId?: string;
  readonly at: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** A structured failure record. */
export interface WorkerFailure {
  readonly id: string;
  readonly taskId: string;
  readonly workerId?: string;
  readonly attempt: number;
  readonly at: string;
  readonly error: WorkerError;
}

/** A recovery action taken by the supervisor. */
export interface WorkerRecovery {
  readonly id: string;
  readonly workerId: string;
  readonly at: string;
  readonly restartCount: number;
  readonly action: "restarted" | "stopped" | "escalated";
}

/** Input accepted by {@link createWorkerRecovery}. */
export interface CreateWorkerRecoveryInput {
  readonly id?: string;
  readonly workerId: string;
  readonly at: string;
  readonly restartCount: number;
  readonly action: WorkerRecovery["action"];
}

/** Build an immutable recovery record (deterministic id). */
export function createWorkerRecovery(input: CreateWorkerRecoveryInput): WorkerRecovery {
  return Object.freeze({
    id: input.id ?? `recovery-${hashString(`${input.workerId}:${input.at}`)}`,
    workerId: input.workerId,
    at: input.at,
    restartCount: input.restartCount,
    action: input.action,
  });
}

/** Lifecycle record of a worker. */
export interface WorkerLifecycle {
  readonly id: string;
  readonly workerId: string;
  readonly status: WorkerStatus;
  readonly startedAt?: string;
  readonly stoppedAt?: string;
  readonly transitions: readonly WorkerHistoryEntry[];
}

/** Startup record. */
export interface WorkerStartup {
  readonly workerId: string;
  readonly at: string;
  readonly config: WorkerConfiguration;
}

/** Shutdown record. */
export interface WorkerShutdown {
  readonly workerId: string;
  readonly at: string;
  readonly reason: string;
  readonly graceful: boolean;
}

/** Supervisor configuration. */
export interface WorkerSupervisor {
  readonly id: string;
  readonly intervalMs: number;
  readonly maxRestarts: number;
  readonly escalationThreshold: number;
  readonly lastRunAt?: string;
}

/** A supervisor/health report for a worker. */
export interface WorkerReport {
  readonly id: string;
  readonly workerId: string;
  readonly at: string;
  readonly health: WorkerHealth;
  readonly metrics: WorkerMetrics;
  readonly summary: WorkerSummary;
}

// ─────────────────────────────────────────────────────────────
// Deterministic id helpers (shared FNV-1a — never reimplemented).
// ─────────────────────────────────────────────────────────────

/** Deterministic worker id. */
export function workerIdFor(name: string, pool: string, createdAt: string): string {
  return `worker-${hashString(`${name}:${pool}:${createdAt}`)}`;
}

/** Deterministic task id. */
export function taskIdFor(
  name: string,
  kind: WorkerTaskKind,
  priority: WorkerPriority,
  createdAt: string,
  scheduledAt?: string,
): string {
  return `task-${hashString(
    `${name}:${kind}:${priority}:${createdAt}:${scheduledAt ?? ""}`,
  )}`;
}

/** Deterministic lease id. */
export function leaseIdFor(taskId: string, workerId: string, acquiredAt: string): string {
  return `lease-${hashString(`${taskId}:${workerId}:${acquiredAt}`)}`;
}

/** Deterministic execution id. */
export function executionIdFor(
  taskId: string,
  workerId: string,
  attempt: number,
  startedAt: string,
): string {
  return `exec-${hashString(`${taskId}:${workerId}:${attempt}:${startedAt}`)}`;
}

/** Deterministic pool id. */
export function poolIdFor(name: string, createdAt: string): string {
  return `pool-${hashString(`${name}:${createdAt}`)}`;
}

// ─────────────────────────────────────────────────────────────
// Worker construction.
// ─────────────────────────────────────────────────────────────

/** Input accepted by {@link createWorker}. */
export interface CreateWorkerInput {
  readonly id?: string;
  readonly name: string;
  readonly pool: string;
  readonly priority?: WorkerPriority;
  readonly capabilities?: readonly string[];
  readonly capacity?: Partial<WorkerCapacity>;
  readonly limits?: Partial<WorkerLimits>;
  readonly status?: WorkerStatus;
  readonly state?: WorkerState;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly metadata?: Partial<WorkerMetadata>;
  /** Defaults merged over the worker's own limits. */
  readonly defaults?: Partial<WorkerConfiguration>;
}

/** Build a new immutable worker. */
export function createWorker(input: CreateWorkerInput): Worker {
  const defaults: WorkerConfiguration = createWorkerConfiguration({
    capacity: input.capacity,
    limits: input.limits,
    ...(input.defaults !== undefined ? input.defaults : {}),
  });
  const capacity: WorkerCapacity = {
    maxConcurrent: input.capacity?.maxConcurrent ?? defaults.capacity.maxConcurrent,
    busy: 0,
    weight: input.capacity?.weight ?? defaults.capacity.weight,
  };
  const createdAt = input.createdAt;
  const id = input.id ?? workerIdFor(input.name, input.pool, createdAt);
  const registration: WorkerRegistration = {
    workerId: id,
    at: createdAt,
    pool: input.pool,
    capabilities: input.capabilities !== undefined ? [...input.capabilities] : [],
  };
  const health: WorkerHealth = { status: "unknown", score: 1 };
  return {
    id,
    name: input.name,
    pool: input.pool,
    status: input.status ?? "registered",
    state: input.state ?? "idle",
    priority: input.priority ?? "normal",
    capabilities: [...registration.capabilities],
    capacity,
    limits: defaults.limits,
    registration,
    health,
    failures: 0,
    restartCount: 0,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    history: [],
    metadata: { tags: input.metadata?.tags !== undefined ? [...input.metadata.tags] : [] },
  };
}

/** Return a deep, detached copy of a worker (never frozen). */
export function cloneWorker(worker: Worker): Worker {
  return {
    id: worker.id,
    name: worker.name,
    pool: worker.pool,
    status: worker.status,
    state: worker.state,
    priority: worker.priority,
    capabilities: [...worker.capabilities],
    capacity: { ...worker.capacity },
    limits: { ...worker.limits },
    registration: {
      workerId: worker.registration.workerId,
      at: worker.registration.at,
      pool: worker.registration.pool,
      capabilities: [...worker.registration.capabilities],
    },
    ...(worker.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: worker.lastHeartbeatAt } : {}),
    health: {
      status: worker.health.status,
      score: worker.health.score,
      ...(worker.health.lastHeartbeatAt !== undefined
        ? { lastHeartbeatAt: worker.health.lastHeartbeatAt }
        : {}),
    },
    failures: worker.failures,
    restartCount: worker.restartCount,
    createdAt: worker.createdAt,
    updatedAt: worker.updatedAt,
    ...(worker.startedAt !== undefined ? { startedAt: worker.startedAt } : {}),
    ...(worker.stoppedAt !== undefined ? { stoppedAt: worker.stoppedAt } : {}),
    ...(worker.pausedAt !== undefined ? { pausedAt: worker.pausedAt } : {}),
    history: worker.history.map((entry) => ({ ...entry })),
    metadata: { tags: [...worker.metadata.tags] },
  };
}

/** Deep-freeze a worker in place and return it (idempotent). */
export function freezeWorker(worker: Worker): Worker {
  Object.freeze(worker.capabilities);
  Object.freeze(worker.capacity);
  Object.freeze(worker.limits);
  Object.freeze(worker.registration.capabilities);
  Object.freeze(worker.registration);
  Object.freeze(worker.health);
  Object.freeze(worker.history);
  Object.freeze(worker.metadata.tags);
  Object.freeze(worker.metadata);
  return Object.freeze(worker);
}

/** Patch applied by {@link touchWorker}. */
export interface WorkerPatch {
  readonly status?: WorkerStatus;
  readonly state?: WorkerState;
  readonly lastHeartbeatAt?: string;
  readonly health?: Partial<WorkerHealth>;
  readonly failures?: number;
  readonly restartCount?: number;
  readonly startedAt?: string | null;
  readonly stoppedAt?: string | null;
  readonly pausedAt?: string | null;
  readonly capacity?: Partial<WorkerCapacity>;
  readonly updatedAt: string;
  readonly history?: readonly WorkerHistoryEntry[];
}

/** Return the successor worker with `patch` applied (input never mutated). */
export function touchWorker(worker: Worker, patch: WorkerPatch): Worker {
  return {
    id: worker.id,
    name: worker.name,
    pool: worker.pool,
    status: patch.status ?? worker.status,
    state: patch.state ?? worker.state,
    priority: worker.priority,
    capabilities: [...worker.capabilities],
    capacity: {
      maxConcurrent: patch.capacity?.maxConcurrent ?? worker.capacity.maxConcurrent,
      busy: patch.capacity?.busy ?? worker.capacity.busy,
      weight: patch.capacity?.weight ?? worker.capacity.weight,
    },
    limits: { ...worker.limits },
    registration: {
      workerId: worker.registration.workerId,
      at: worker.registration.at,
      pool: worker.registration.pool,
      capabilities: [...worker.registration.capabilities],
    },
    ...(patch.lastHeartbeatAt !== undefined
      ? { lastHeartbeatAt: patch.lastHeartbeatAt }
      : worker.lastHeartbeatAt !== undefined
        ? { lastHeartbeatAt: worker.lastHeartbeatAt }
        : {}),
    health: {
      status: patch.health?.status ?? worker.health.status,
      score: patch.health?.score ?? worker.health.score,
      ...(patch.health?.lastHeartbeatAt !== undefined
        ? { lastHeartbeatAt: patch.health.lastHeartbeatAt }
        : worker.health.lastHeartbeatAt !== undefined
          ? { lastHeartbeatAt: worker.health.lastHeartbeatAt }
          : {}),
    },
    failures: patch.failures ?? worker.failures,
    restartCount: patch.restartCount ?? worker.restartCount,
    createdAt: worker.createdAt,
    updatedAt: patch.updatedAt,
    ...(patch.startedAt !== undefined
      ? patch.startedAt !== null
        ? { startedAt: patch.startedAt }
        : {}
      : worker.startedAt !== undefined
        ? { startedAt: worker.startedAt }
        : {}),
    ...(patch.stoppedAt !== undefined
      ? patch.stoppedAt !== null
        ? { stoppedAt: patch.stoppedAt }
        : {}
      : worker.stoppedAt !== undefined
        ? { stoppedAt: worker.stoppedAt }
        : {}),
    ...(patch.pausedAt !== undefined
      ? patch.pausedAt !== null
        ? { pausedAt: patch.pausedAt }
        : {}
      : worker.pausedAt !== undefined
        ? { pausedAt: worker.pausedAt }
        : {}),
    history: patch.history !== undefined ? patch.history.map((entry) => ({ ...entry })) : worker.history.map((entry) => ({ ...entry })),
    metadata: { tags: [...worker.metadata.tags] },
  };
}

/** Whether the worker can accept a new task right now. */
export function isWorkerAvailable(worker: Worker, now: string): boolean {
  if (worker.status !== "idle" && worker.status !== "running") return false;
  if (worker.state !== "idle" && worker.state !== "running") return false;
  if (worker.capacity.busy >= worker.capacity.maxConcurrent) return false;
  return isWorkerHealthy(worker, now);
}

/** Whether the worker's heartbeat is fresh enough to be considered alive. */
export function isWorkerHealthy(worker: Worker, now: string): boolean {
  if (worker.lastHeartbeatAt === undefined) return true;
  const heartbeatMs = Date.parse(worker.lastHeartbeatAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(heartbeatMs) || Number.isNaN(nowMs)) return true;
  return nowMs - heartbeatMs <= worker.limits.heartbeatTimeoutMs;
}

/** Estimate the cost (slots) a worker can contribute. */
export function estimateWorkerCost(worker: Worker): number {
  return worker.capacity.maxConcurrent * worker.capacity.weight;
}

/** Deterministic hash of a worker's identity. */
export function hashWorker(worker: Worker): string {
  return hashString(`${worker.id}:${worker.updatedAt}:${worker.status}:${worker.state}`);
}

/** Build a stable worker reference. */
export function createWorkerReference(worker: Worker): WorkerReference {
  return Object.freeze({ id: worker.id, kind: "worker", name: worker.name });
}

/** Build a lightweight worker summary. */
export function createWorkerSummary(worker: Worker): WorkerSummary {
  return {
    id: worker.id,
    name: worker.name,
    pool: worker.pool,
    status: worker.status,
    state: worker.state,
    priority: worker.priority,
    capacity: { ...worker.capacity },
    health: { ...worker.health },
    ...(worker.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: worker.lastHeartbeatAt } : {}),
  };
}

// ─────────────────────────────────────────────────────────────
// Task construction.
// ─────────────────────────────────────────────────────────────

/** Input accepted by {@link createWorkerTask}. */
export interface CreateWorkerTaskInput {
  readonly id?: string;
  readonly name: string;
  readonly kind: WorkerTaskKind;
  readonly priority?: WorkerPriority;
  readonly payload: WorkerTaskPayload;
  readonly dependencies?: readonly string[];
  readonly retryPolicy?: WorkerRetryPolicy;
  readonly schedule?: WorkerSchedule;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly createdAt: string;
  readonly scheduledAt?: string;
  readonly metadata?: Partial<WorkerMetadata>;
}

/** Build a new immutable worker task. */
export function createWorkerTask(input: CreateWorkerTaskInput): WorkerTask {
  const id =
    input.id ??
    taskIdFor(
      input.name,
      input.kind,
      input.priority ?? "normal",
      input.createdAt,
      input.scheduledAt,
    );
  return {
    id,
    name: input.name,
    kind: input.kind,
    priority: input.priority ?? "normal",
    status: input.scheduledAt !== undefined ? "scheduled" : "pending",
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 1,
    dependencies: input.dependencies !== undefined ? [...input.dependencies] : [],
    payload: { ...input.payload } as WorkerTaskPayload,
    ...(input.retryPolicy !== undefined
      ? { retryPolicy: { ...input.retryPolicy } }
      : {}),
    ...(input.schedule !== undefined
      ? {
          schedule: {
            ...input.schedule,
            ...(input.schedule.at !== undefined ? { at: input.schedule.at } : {}),
            ...(input.schedule.everyMs !== undefined ? { everyMs: input.schedule.everyMs } : {}),
            ...(input.schedule.cron !== undefined ? { cron: input.schedule.cron } : {}),
          },
        }
      : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    metadata: { tags: input.metadata?.tags !== undefined ? [...input.metadata.tags] : [] },
    createdAt: input.createdAt,
    ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
    archived: false,
    history: [],
  };
}

/** Return a deep, detached copy of a task (never frozen). */
export function cloneWorkerTask(task: WorkerTask): WorkerTask {
  return {
    id: task.id,
    name: task.name,
    kind: task.kind,
    priority: task.priority,
    status: task.status,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    dependencies: [...task.dependencies],
    payload: { ...task.payload } as WorkerTaskPayload,
    ...(task.retryPolicy !== undefined
      ? { retryPolicy: { ...task.retryPolicy } }
      : {}),
    ...(task.schedule !== undefined
      ? {
          schedule: {
            ...(task.schedule.everyMs !== undefined ? { everyMs: task.schedule.everyMs } : {}),
            ...(task.schedule.at !== undefined ? { at: task.schedule.at } : {}),
            ...(task.schedule.cron !== undefined ? { cron: task.schedule.cron } : {}),
          },
        }
      : {}),
    ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
    metadata: { tags: [...task.metadata.tags] },
    createdAt: task.createdAt,
    ...(task.scheduledAt !== undefined ? { scheduledAt: task.scheduledAt } : {}),
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.completedAt !== undefined ? { completedAt: task.completedAt } : {}),
    ...(task.error !== undefined ? { error: { ...task.error } } : {}),
    ...(task.result !== undefined ? { result: { ...task.result } } : {}),
    archived: task.archived,
    history: task.history.map((entry) => ({ ...entry })),
  };
}

/** Deep-freeze a task in place and return it (idempotent). */
export function freezeWorkerTask(task: WorkerTask): WorkerTask {
  Object.freeze(task.dependencies);
  Object.freeze(task.payload);
  if (task.retryPolicy !== undefined) Object.freeze(task.retryPolicy);
  if (task.schedule !== undefined) Object.freeze(task.schedule);
  Object.freeze(task.metadata.tags);
  Object.freeze(task.metadata);
  Object.freeze(task.history);
  return Object.freeze(task);
}

/** Patch applied by {@link touchWorkerTask}. */
export interface WorkerTaskPatch {
  readonly status?: WorkerTaskStatus;
  readonly attempts?: number;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly error?: WorkerError | null;
  readonly result?: WorkerExecutionResult | null;
  readonly archived?: boolean;
  readonly scheduledAt?: string | null;
  readonly history?: readonly WorkerHistoryEntry[];
}

/** Return the successor task with `patch` applied (input never mutated). */
export function touchWorkerTask(task: WorkerTask, patch: WorkerTaskPatch): WorkerTask {
  return {
    id: task.id,
    name: task.name,
    kind: task.kind,
    priority: task.priority,
    status: patch.status ?? task.status,
    attempts: patch.attempts ?? task.attempts,
    maxAttempts: task.maxAttempts,
    dependencies: [...task.dependencies],
    payload: { ...task.payload } as WorkerTaskPayload,
    ...(task.retryPolicy !== undefined
      ? { retryPolicy: { ...task.retryPolicy } }
      : {}),
    ...(task.schedule !== undefined
      ? {
          schedule: {
            ...(task.schedule.everyMs !== undefined ? { everyMs: task.schedule.everyMs } : {}),
            ...(task.schedule.at !== undefined ? { at: task.schedule.at } : {}),
            ...(task.schedule.cron !== undefined ? { cron: task.schedule.cron } : {}),
          },
        }
      : {}),
    ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
    metadata: { tags: [...task.metadata.tags] },
    createdAt: task.createdAt,
    ...(patch.scheduledAt !== undefined
      ? patch.scheduledAt !== null
        ? { scheduledAt: patch.scheduledAt }
        : {}
      : task.scheduledAt !== undefined
        ? { scheduledAt: task.scheduledAt }
        : {}),
    ...(patch.startedAt !== undefined
      ? patch.startedAt !== null
        ? { startedAt: patch.startedAt }
        : {}
      : task.startedAt !== undefined
        ? { startedAt: task.startedAt }
        : {}),
    ...(patch.completedAt !== undefined
      ? patch.completedAt !== null
        ? { completedAt: patch.completedAt }
        : {}
      : task.completedAt !== undefined
        ? { completedAt: task.completedAt }
        : {}),
    ...(patch.error !== undefined
      ? patch.error !== null
        ? { error: { ...patch.error } }
        : {}
      : task.error !== undefined
        ? { error: { ...task.error } }
        : {}),
    ...(patch.result !== undefined
      ? patch.result !== null
        ? { result: { ...patch.result } }
        : {}
      : task.result !== undefined
        ? { result: { ...task.result } }
        : {}),
    archived: patch.archived ?? task.archived,
    history: patch.history !== undefined ? patch.history.map((entry) => ({ ...entry })) : task.history.map((entry) => ({ ...entry })),
  };
}

/** Whether the task is runnable at `now` (pending, deps settled externally). */
export function isTaskRunnable(task: WorkerTask, now: string): boolean {
  if (task.archived) return false;
  if (task.status !== "pending" && task.status !== "scheduled" && task.status !== "retrying") {
    return false;
  }
  if (task.scheduledAt === undefined) return true;
  return Date.parse(task.scheduledAt) <= Date.parse(now);
}

/** Estimate the cost of a task (priority-weighted). */
export function estimateTaskCost(task: WorkerTask): number {
  return PRIORITY_RANK[task.priority] * (task.maxAttempts - task.attempts);
}

/** Deterministic hash of a task's identity. */
export function hashTask(task: WorkerTask): string {
  return hashString(`${task.id}:${task.status}:${task.attempts}`);
}

/** Build a stable task reference. */
export function createTaskReference(task: WorkerTask): WorkerReference {
  return Object.freeze({ id: task.id, kind: "task", name: task.name });
}

// ─────────────────────────────────────────────────────────────
// Lease / execution / heartbeat construction.
// ─────────────────────────────────────────────────────────────

/** Input accepted by {@link createWorkerLease}. */
export interface CreateWorkerLeaseInput {
  readonly id?: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly status?: WorkerLease["status"];
}

/** Build a new immutable lease. */
export function createWorkerLease(input: CreateWorkerLeaseInput): WorkerLease {
  return {
    id: input.id ?? leaseIdFor(input.taskId, input.workerId, input.acquiredAt),
    taskId: input.taskId,
    workerId: input.workerId,
    acquiredAt: input.acquiredAt,
    expiresAt: input.expiresAt,
    status: input.status ?? "active",
  };
}

/** Return a detached copy of a lease. */
export function cloneWorkerLease(lease: WorkerLease): WorkerLease {
  return {
    id: lease.id,
    taskId: lease.taskId,
    workerId: lease.workerId,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    ...(lease.renewedAt !== undefined ? { renewedAt: lease.renewedAt } : {}),
    status: lease.status,
  };
}

/** Deep-freeze a lease in place and return it. */
export function freezeWorkerLease(lease: WorkerLease): WorkerLease {
  return Object.freeze(lease);
}

/** Whether a lease is still active at `now`. */
export function isLeaseActive(lease: WorkerLease, now: string): boolean {
  if (lease.status !== "active") return false;
  return Date.parse(lease.expiresAt) > Date.parse(now);
}

/** Input accepted by {@link createWorkerExecution}. */
export interface CreateWorkerExecutionInput {
  readonly id?: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly attempt: number;
  readonly status?: WorkerExecution["status"];
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly output?: unknown;
  readonly error?: WorkerError;
  readonly durationMs?: number;
}

/** Build a new immutable execution record. */
export function createWorkerExecution(input: CreateWorkerExecutionInput): WorkerExecution {
  return {
    id:
      input.id ??
      executionIdFor(input.taskId, input.workerId, input.attempt, input.startedAt),
    taskId: input.taskId,
    workerId: input.workerId,
    attempt: input.attempt,
    status: input.status ?? "running",
    startedAt: input.startedAt,
    ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(input.error !== undefined ? { error: { ...input.error } } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  };
}

/** Build an immutable heartbeat. */
export function createWorkerHeartbeat(
  workerId: string,
  at: string,
  state?: WorkerState,
): WorkerHeartbeat {
  return Object.freeze({
    workerId,
    at,
    ...(state !== undefined ? { state } : {}),
  });
}

// ─────────────────────────────────────────────────────────────
// Pool / batch / signal / event construction.
// ─────────────────────────────────────────────────────────────

/** Input accepted by {@link createWorkerPool}. */
export interface CreateWorkerPoolInput {
  readonly id?: string;
  readonly name: string;
  readonly workerIds?: readonly string[];
  readonly createdAt: string;
}

/** Build a new immutable pool. */
export function createWorkerPool(input: CreateWorkerPoolInput): WorkerPool {
  const workerIds = input.workerIds !== undefined ? [...input.workerIds] : [];
  return {
    id: input.id ?? poolIdFor(input.name, input.createdAt),
    name: input.name,
    size: workerIds.length,
    workerIds,
    createdAt: input.createdAt,
  };
}

/** Input accepted by {@link createWorkerBatch}. */
export interface CreateWorkerBatchInput {
  readonly id?: string;
  readonly taskIds: readonly string[];
  readonly createdAt: string;
  readonly status?: WorkerBatch["status"];
}

/** Build a new immutable batch. */
export function createWorkerBatch(input: CreateWorkerBatchInput): WorkerBatch {
  return {
    id: input.id ?? `batch-${hashString(`${input.createdAt}:${input.taskIds.join(":")}`)}`,
    taskIds: [...input.taskIds],
    createdAt: input.createdAt,
    status: input.status ?? "pending",
  };
}

/** Input accepted by {@link createWorkerSignal}. */
export interface CreateWorkerSignalInput {
  readonly id?: string;
  readonly kind: WorkerSignalKind;
  readonly workerId: string;
  readonly at: string;
  readonly reason?: string;
}

/** Build a new immutable signal. */
export function createWorkerSignal(input: CreateWorkerSignalInput): WorkerSignal {
  return Object.freeze({
    id: input.id ?? `signal-${hashString(`${input.kind}:${input.workerId}:${input.at}`)}`,
    kind: input.kind,
    workerId: input.workerId,
    at: input.at,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
}

/** Input accepted by {@link createWorkerEvent}. */
export interface CreateWorkerEventInput {
  readonly id?: string;
  readonly type: WorkerEventType;
  readonly workerId?: string;
  readonly taskId?: string;
  readonly at: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** Build a new immutable worker event. */
export function createWorkerEvent(input: CreateWorkerEventInput): WorkerEvent {
  return Object.freeze({
    id:
      input.id ??
      `wevent-${hashString(
        `${input.type}:${input.workerId ?? ""}:${input.taskId ?? ""}:${input.at}`,
      )}`,
    type: input.type,
    ...(input.workerId !== undefined ? { workerId: input.workerId } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    at: input.at,
    ...(input.payload !== undefined ? { payload: Object.freeze({ ...input.payload }) } : {}),
  });
}

// ─────────────────────────────────────────────────────────────
// Configuration / statistics / metrics / reports.
// ─────────────────────────────────────────────────────────────

/** Input accepted by {@link createWorkerConfiguration}. */
export interface CreateWorkerConfigurationInput {
  readonly heartbeatIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly maxRestarts?: number;
  readonly maxTaskAttempts?: number;
  readonly capacity?: Partial<WorkerCapacity>;
  readonly limits?: Partial<WorkerLimits>;
  readonly retryPolicy?: Partial<WorkerRetryPolicy>;
  readonly supervisorIntervalMs?: number;
}

/** Build the default worker configuration (deterministic). */
export function createWorkerConfiguration(
  input: CreateWorkerConfigurationInput = {},
): WorkerConfiguration {
  const capacity: WorkerCapacity = {
    maxConcurrent: input.capacity?.maxConcurrent ?? 1,
    busy: 0,
    weight: input.capacity?.weight ?? 1,
  };
  const limits: WorkerLimits = Object.freeze({
    maxTasks: input.limits?.maxTasks ?? input.capacity?.maxConcurrent ?? 1,
    maxRestarts: input.limits?.maxRestarts ?? 3,
    leaseDurationMs:
      input.leaseDurationMs ?? input.limits?.leaseDurationMs ?? 30_000,
    heartbeatTimeoutMs:
      input.heartbeatTimeoutMs ?? input.limits?.heartbeatTimeoutMs ?? 60_000,
  });
  return Object.freeze({
    heartbeatIntervalMs: input.heartbeatIntervalMs ?? 5_000,
    leaseDurationMs: input.leaseDurationMs ?? limits.leaseDurationMs,
    heartbeatTimeoutMs: input.heartbeatTimeoutMs ?? limits.heartbeatTimeoutMs,
    maxRestarts: input.maxRestarts ?? limits.maxRestarts,
    maxTaskAttempts: input.maxTaskAttempts ?? 3,
    capacity: Object.freeze({ ...capacity }),
    limits,
    retryPolicy: Object.freeze({
      maxRetries: input.retryPolicy?.maxRetries ?? 0,
      backoffMs: input.retryPolicy?.backoffMs ?? 1_000,
      ...(input.retryPolicy?.retryableCodes !== undefined
        ? { retryableCodes: Object.freeze([...input.retryPolicy.retryableCodes]) }
        : {}),
      ...(input.retryPolicy?.maxDelayMs !== undefined
        ? { maxDelayMs: input.retryPolicy.maxDelayMs }
        : {}),
    }),
    supervisorIntervalMs: input.supervisorIntervalMs ?? 15_000,
  });
}

/** Input accepted by {@link createWorkerStatistics}. */
export interface CreateWorkerStatisticsInput {
  readonly workers?: Partial<WorkerStatistics["workers"]>;
  readonly tasks?: Partial<WorkerStatistics["tasks"]>;
  readonly leases?: Partial<WorkerStatistics["leases"]>;
}

/** Build an immutable statistics record (all counters default to 0). */
export function createWorkerStatistics(
  input: CreateWorkerStatisticsInput = {},
): WorkerStatistics {
  return Object.freeze({
    workers: Object.freeze({
      registered: input.workers?.registered ?? 0,
      active: input.workers?.active ?? 0,
      idle: input.workers?.idle ?? 0,
      busy: input.workers?.busy ?? 0,
      paused: input.workers?.paused ?? 0,
      stopped: input.workers?.stopped ?? 0,
      failed: input.workers?.failed ?? 0,
      dead: input.workers?.dead ?? 0,
    }),
    tasks: Object.freeze({
      pending: input.tasks?.pending ?? 0,
      scheduled: input.tasks?.scheduled ?? 0,
      delayed: input.tasks?.delayed ?? 0,
      leased: input.tasks?.leased ?? 0,
      running: input.tasks?.running ?? 0,
      completed: input.tasks?.completed ?? 0,
      failed: input.tasks?.failed ?? 0,
      cancelled: input.tasks?.cancelled ?? 0,
      retrying: input.tasks?.retrying ?? 0,
      dead: input.tasks?.dead ?? 0,
    }),
    leases: Object.freeze({
      active: input.leases?.active ?? 0,
      expired: input.leases?.expired ?? 0,
      total: input.leases?.total ?? 0,
    }),
  });
}

/** Input accepted by {@link createWorkerMetrics}. */
export interface CreateWorkerMetricsInput {
  readonly tasksCompleted?: number;
  readonly tasksFailed?: number;
  readonly tasksCancelled?: number;
  readonly tasksRetried?: number;
  readonly totalRuns?: number;
  readonly totalDurationMs?: number;
  readonly queueDepth?: number;
}

/** Build an immutable metrics accumulator. */
export function createWorkerMetrics(input: CreateWorkerMetricsInput = {}): WorkerMetrics {
  return Object.freeze({
    tasksCompleted: input.tasksCompleted ?? 0,
    tasksFailed: input.tasksFailed ?? 0,
    tasksCancelled: input.tasksCancelled ?? 0,
    tasksRetried: input.tasksRetried ?? 0,
    totalRuns: input.totalRuns ?? 0,
    totalDurationMs: input.totalDurationMs ?? 0,
    queueDepth: input.queueDepth ?? 0,
  });
}

/** Input accepted by {@link createWorkerSnapshot}. */
export interface CreateWorkerSnapshotInput {
  readonly at: string;
  readonly workers?: readonly Worker[];
  readonly tasks?: readonly WorkerTask[];
  readonly pools?: readonly WorkerPool[];
  readonly leases?: readonly WorkerLease[];
  readonly statistics?: WorkerStatistics;
}

/** Build an immutable snapshot of the worker layer. */
export function createWorkerSnapshot(input: CreateWorkerSnapshotInput): WorkerSnapshot {
  return Object.freeze({
    at: input.at,
    workers: Object.freeze([...(input.workers ?? [])]),
    tasks: Object.freeze([...(input.tasks ?? [])]),
    pools: Object.freeze([...(input.pools ?? [])]),
    leases: Object.freeze([...(input.leases ?? [])]),
    statistics:
      input.statistics ?? createWorkerStatistics(),
  });
}

/** Input accepted by {@link createWorkerReport}. */
export interface CreateWorkerReportInput {
  readonly id?: string;
  readonly workerId: string;
  readonly at: string;
  readonly health: WorkerHealth;
  readonly metrics: WorkerMetrics;
  readonly summary: WorkerSummary;
}

/** Build an immutable worker report. */
export function createWorkerReport(input: CreateWorkerReportInput): WorkerReport {
  return Object.freeze({
    id: input.id ?? `report-${hashString(`${input.workerId}:${input.at}`)}`,
    workerId: input.workerId,
    at: input.at,
    health: Object.freeze({ ...input.health }),
    metrics: Object.freeze({ ...input.metrics }),
    summary: Object.freeze({
      id: input.summary.id,
      name: input.summary.name,
      pool: input.summary.pool,
      status: input.summary.status,
      state: input.summary.state,
      priority: input.summary.priority,
      capacity: Object.freeze({ ...input.summary.capacity }),
      health: Object.freeze({ ...input.summary.health }),
      ...(input.summary.lastHeartbeatAt !== undefined
        ? { lastHeartbeatAt: input.summary.lastHeartbeatAt }
        : {}),
    }),
  });
}
