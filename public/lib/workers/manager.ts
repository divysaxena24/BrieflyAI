/**
 * Background Worker Infrastructure — worker manager (Phase 6B STEP 5).
 *
 * The successor-based lifecycle facade over the worker layer: it owns the
 * immutable `WorkerRegistry`, the pending/delayed/retry queues, the task
 * store, leases, executions and the dead letter queue. Every mutation
 * returns a successor `WorkerManager` — the receiver is never changed.
 *
 * Lifecycle: `registerWorker` → `startWorker` → `heartbeat` → `leaseTask` →
 * `completeTask` / `failTask` / `cancelTask` → `stopWorker`; `expireLeases`
 * recovers stale leases; `cleanup` prunes settled state; `rebalance` and
 * `scalePool` manage load; bulk operations batch transitions atomically.
 *
 * All timestamps are caller-supplied; all ordering is deterministic.
 */

import { WorkerRegistry } from "./registry";
import { WorkerQueue, createQueueItem, type WorkerQueueStatistics } from "./queue";
import { DeadLetterQueue, createDeadLetterEntry } from "./deadLetter";
import { dependenciesSatisfied, selectNextItem, type SelectOptions } from "./scheduler";
import {
  createWorker,
  createWorkerConfiguration,
  createWorkerExecution,
  createWorkerLease,
  createWorkerPool,
  createWorkerSnapshot,
  createWorkerStatistics,
  createWorkerTask,
  isWorkerAvailable,
  touchWorker,
  touchWorkerTask,
  type CreateWorkerConfigurationInput,
  type CreateWorkerInput,
  type CreateWorkerTaskInput,
  type Worker,
  type WorkerConfiguration,
  type WorkerError,
  type WorkerExecution,
  type WorkerLease,
  type WorkerPool,
  type WorkerSnapshot,
  type WorkerStatistics,
  type WorkerTask,
  type WorkerTaskStatus,
} from "./types";

/** Default retention (ms) applied by {@link WorkerManager.cleanup}. */
export const DEFAULT_CLEANUP_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Raised when an operation targets an unknown task. */
export class WorkerTaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = "WorkerTaskNotFoundError";
  }
}

/** Raised when a task is already stored (duplicate id). */
export class WorkerTaskDuplicateError extends Error {
  constructor(taskId: string) {
    super(`Task already registered: ${taskId}`);
    this.name = "WorkerTaskDuplicateError";
  }
}

/** Raised when leasing requires an unavailable worker. */
export class WorkerUnavailableError extends Error {
  constructor(workerId: string) {
    super(`Worker is not available to run a task: ${workerId}`);
    this.name = "WorkerUnavailableError";
  }
}

/**
 * Deterministic retry delay: exponential backoff capped by the policy's
 * `maxDelayMs`. `attempts` is the number of attempts already made.
 */
export function retryDelayFor(
  backoffMs: number,
  attempts: number,
  maxDelayMs?: number,
): number {
  const base = backoffMs * 2 ** Math.max(0, attempts - 1);
  if (maxDelayMs === undefined) return base;
  return Math.min(base, maxDelayMs);
}

/** Options accepted by the {@link WorkerManager} constructor. */
export interface WorkerManagerOptions {
  readonly configuration?: WorkerConfiguration;
  readonly registry?: WorkerRegistry;
  readonly pending?: WorkerQueue;
  readonly delayed?: WorkerQueue;
  readonly retry?: WorkerQueue;
  readonly tasks?: readonly WorkerTask[];
  readonly leases?: readonly WorkerLease[];
  readonly executions?: readonly WorkerExecution[];
  readonly deadLetter?: DeadLetterQueue;
}

/** The worker manager — successor-based lifecycle facade. */
export class WorkerManager {
  readonly configuration: WorkerConfiguration;
  readonly registry: WorkerRegistry;
  /** The due-now task queue (priority/FIFO). */
  readonly pending: WorkerQueue;
  /** Tasks scheduled for a future time. */
  readonly delayed: WorkerQueue;
  /** Failed tasks awaiting a retry. */
  readonly retry: WorkerQueue;
  /** Every known task, in registration order. */
  readonly tasks: readonly WorkerTask[];
  /** Active/historical leases. */
  readonly leases: readonly WorkerLease[];
  /** Execution records. */
  readonly executions: readonly WorkerExecution[];
  /** Dead letter entries. */
  readonly deadLetter: DeadLetterQueue;

  constructor(options: WorkerManagerOptions = {}) {
    this.configuration =
      options.configuration ?? createWorkerConfiguration();
    this.registry = options.registry ?? new WorkerRegistry();
    this.pending = options.pending ?? new WorkerQueue("priority", { createdAt: "1970-01-01T00:00:00.000Z" });
    this.delayed = options.delayed ?? new WorkerQueue("delayed", { createdAt: "1970-01-01T00:00:00.000Z" });
    this.retry = options.retry ?? new WorkerQueue("retry", { createdAt: "1970-01-01T00:00:00.000Z" });
    this.tasks = Object.freeze([...(options.tasks ?? [])]);
    this.leases = Object.freeze([...(options.leases ?? [])]);
    this.executions = Object.freeze([...(options.executions ?? [])]);
    this.deadLetter = options.deadLetter ?? new DeadLetterQueue();
  }

  /** Build a successor manager from partial state. */
  private next(partial: WorkerManagerOptions): WorkerManager {
    return new WorkerManager({
      configuration: this.configuration,
      registry: partial.registry ?? this.registry,
      pending: partial.pending ?? this.pending,
      delayed: partial.delayed ?? this.delayed,
      retry: partial.retry ?? this.retry,
      tasks: partial.tasks ?? this.tasks,
      leases: partial.leases ?? this.leases,
      executions: partial.executions ?? this.executions,
      deadLetter: partial.deadLetter ?? this.deadLetter,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Reads.
  // ─────────────────────────────────────────────────────────────

  /** The stored worker, or `undefined` (detached clone). */
  find(workerId: string): Worker | undefined {
    return this.registry.find(workerId);
  }

  /** The stored task, or `undefined` (detached clone). */
  findTask(taskId: string): WorkerTask | undefined {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    return task === undefined ? undefined : touchWorkerTask(task, {});
  }

  /** Whether a worker is registered. */
  hasWorker(workerId: string): boolean {
    return this.registry.has(workerId);
  }

  /** Whether a task is registered. */
  hasTask(taskId: string): boolean {
    return this.tasks.some((task) => task.id === taskId);
  }

  /** Detached clones of every worker. */
  listWorkers(): Worker[] {
    return this.registry.list();
  }

  /** Detached clones of every task, in registration order. */
  listTasks(): WorkerTask[] {
    return this.tasks.map((task) => touchWorkerTask(task, {}));
  }

  /** Detached copies of every lease. */
  listLeases(): WorkerLease[] {
    return this.leases.map((lease) => ({ ...lease }));
  }

  /** Detached copies of every execution. */
  listExecutions(): WorkerExecution[] {
    return this.executions.map((execution) => ({
      ...execution,
      ...(execution.error !== undefined ? { error: { ...execution.error } } : {}),
    }));
  }

  /** Number of registered workers. */
  countWorkers(): number {
    return this.registry.count();
  }

  /** Number of registered tasks. */
  countTasks(): number {
    return this.tasks.length;
  }

  /** Pools derived deterministically from the registered workers. */
  pools(): WorkerPool[] {
    const byPool = new Map<string, Worker[]>();
    for (const worker of this.registry.list()) {
      const bucket = byPool.get(worker.pool);
      if (bucket === undefined) {
        byPool.set(worker.pool, [worker]);
      } else {
        bucket.push(worker);
      }
    }
    return [...byPool.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([pool, workers]) =>
        createWorkerPool({
          name: pool,
          workerIds: workers.map((worker) => worker.id),
          createdAt: workers.reduce(
            (earliest, worker) =>
              earliest === undefined || Date.parse(worker.createdAt) < Date.parse(earliest)
                ? worker.createdAt
                : earliest,
            workers[0]?.createdAt ?? "1970-01-01T00:00:00.000Z",
          ),
        }),
      );
  }

  /** Whether a task's dependencies are satisfied. */
  dependenciesReady(taskId: string): boolean {
    const task = this.findTask(taskId);
    if (task === undefined) return false;
    return dependenciesSatisfied(task, this.tasks);
  }

  /** Deterministic aggregated statistics. */
  statistics(): WorkerStatistics {
    const workerStats = this.registry.statistics();
    const taskStatus = new Map<WorkerTaskStatus, number>();
    for (const task of this.tasks) {
      taskStatus.set(task.status, (taskStatus.get(task.status) ?? 0) + 1);
    }
    const leases = {
      active: this.leases.filter((lease) => lease.status === "active").length,
      expired: this.leases.filter((lease) => lease.status === "expired").length,
      total: this.leases.length,
    };
    return createWorkerStatistics({
      workers: workerStats.workers,
      tasks: {
        pending: taskStatus.get("pending") ?? 0,
        scheduled: taskStatus.get("scheduled") ?? 0,
        delayed: taskStatus.get("delayed") ?? 0,
        leased: taskStatus.get("leased") ?? 0,
        running: taskStatus.get("running") ?? 0,
        completed: taskStatus.get("completed") ?? 0,
        failed: taskStatus.get("failed") ?? 0,
        cancelled: taskStatus.get("cancelled") ?? 0,
        retrying: taskStatus.get("retrying") ?? 0,
        dead: taskStatus.get("dead") ?? 0,
      },
      leases,
    });
  }

  /** A point-in-time snapshot of the worker layer. */
  snapshot(now: string): WorkerSnapshot {
    return createWorkerSnapshot({
      at: now,
      workers: this.listWorkers(),
      tasks: this.listTasks(),
      pools: this.pools(),
      leases: this.listLeases(),
      statistics: this.statistics(),
    });
  }

  /** Queue statistics for the pending/delayed/retry queues. */
  queueStatistics(now: string): {
    pending: WorkerQueueStatistics;
    delayed: WorkerQueueStatistics;
    retry: WorkerQueueStatistics;
  } {
    return {
      pending: this.pending.statistics(now),
      delayed: this.delayed.statistics(now),
      retry: this.retry.statistics(now),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Worker lifecycle.
  // ─────────────────────────────────────────────────────────────

  /** Register a new worker (successor). */
  registerWorker(input: CreateWorkerInput): { manager: WorkerManager; worker: Worker } {
    const worker = createWorker({
      ...input,
      limits: { ...this.configuration.limits, ...(input.limits ?? {}) },
      capacity: { ...this.configuration.capacity, ...(input.capacity ?? {}) },
    });
    const { registry, worker: stored } = this.registry.register(worker);
    return { manager: this.next({ registry }), worker: stored };
  }

  /** Start a registered worker (successor). */
  startWorker(workerId: string, at: string): { manager: WorkerManager; worker: Worker } {
    const current = this.require(workerId);
    const started = touchWorker(current, {
      status: "running",
      state: "idle",
      startedAt: at,
      stoppedAt: null,
      failures: 0,
      updatedAt: at,
      history: [...current.history, { at, kind: "started" }],
    });
    const { registry, worker } = this.registry.replace(started);
    return { manager: this.next({ registry }), worker };
  }

  /** Pause a worker (successor). */
  pauseWorker(workerId: string, at: string): { manager: WorkerManager; worker: Worker } {
    const current = this.require(workerId);
    const paused = touchWorker(current, {
      status: "paused",
      state: "paused",
      pausedAt: at,
      updatedAt: at,
      history: [...current.history, { at, kind: "paused" }],
    });
    const { registry, worker } = this.registry.replace(paused);
    return { manager: this.next({ registry }), worker };
  }

  /** Resume a paused worker (successor). */
  resumeWorker(workerId: string, at: string): { manager: WorkerManager; worker: Worker } {
    const current = this.require(workerId);
    const resumed = touchWorker(current, {
      status: "running",
      state: current.capacity.busy > 0 ? "busy" : "idle",
      pausedAt: null,
      updatedAt: at,
      history: [...current.history, { at, kind: "resumed" }],
    });
    const { registry, worker } = this.registry.replace(resumed);
    return { manager: this.next({ registry }), worker };
  }

  /** Stop a worker (successor); active leases are released. */
  stopWorker(
    workerId: string,
    at: string,
    reason = "stopped",
  ): { manager: WorkerManager; worker: Worker } {
    const current = this.require(workerId);
    let leases = this.leases;
    const released: WorkerLease[] = [];
    for (const lease of leases) {
      if (lease.workerId === workerId && lease.status === "active") {
        released.push(lease);
        leases = leases.map((entry) =>
          entry.id === lease.id ? { ...entry, status: "released" as const } : entry,
        );
      }
    }
    const stopped = touchWorker(current, {
      status: "stopped",
      state: "stopped",
      stoppedAt: at,
      capacity: { busy: 0 },
      updatedAt: at,
      history: [
        ...current.history,
        ...released.map((lease) => ({
          at,
          kind: "lease.expired" as const,
          detail: `released ${lease.taskId}`,
        })),
        { at, kind: "stopped" as const, detail: reason },
      ],
    });
    const { registry, worker } = this.registry.replace(stopped);
    return { manager: this.next({ registry, leases }), worker };
  }

  /** Restart a worker (successor): resets failures and restarts. */
  restartWorker(workerId: string, at: string): { manager: WorkerManager; worker: Worker } {
    const current = this.require(workerId);
    const restarted = touchWorker(current, {
      status: "running",
      state: "idle",
      restartCount: current.restartCount + 1,
      failures: 0,
      startedAt: at,
      stoppedAt: null,
      updatedAt: at,
      history: [...current.history, { at, kind: "restarted" }],
    });
    const { registry, worker } = this.registry.replace(restarted);
    return { manager: this.next({ registry }), worker };
  }

  /** Record a heartbeat (successor); renews the worker's active leases. */
  heartbeat(
    workerId: string,
    at: string,
    state?: Worker["state"],
  ): { manager: WorkerManager; worker: Worker } {
    const current = this.require(workerId);
    const renewsAt = Date.parse(at) + this.configuration.leaseDurationMs;
    const leases = this.leases.map((lease) =>
      lease.workerId === workerId && lease.status === "active"
        ? { ...lease, renewedAt: at, expiresAt: new Date(renewsAt).toISOString() }
        : lease,
    );
    const nextState: Worker["state"] = state ?? current.state;
    const updated = touchWorker(current, {
      lastHeartbeatAt: at,
      health: { status: "healthy", score: 1, lastHeartbeatAt: at },
      state: nextState,
      updatedAt: at,
      history: [...current.history, { at, kind: "heartbeat" }],
    });
    const { registry, worker } = this.registry.replace(updated);
    return { manager: this.next({ registry, leases }), worker };
  }

  // ─────────────────────────────────────────────────────────────
  // Task lifecycle.
  // ─────────────────────────────────────────────────────────────

  /**
   * Register a task (successor). Tasks with a future `scheduledAt` are
   * queued in `delayed`; everything else goes to `pending`.
   */
  enqueueTask(
    input: CreateWorkerTaskInput,
    now: string,
  ): { manager: WorkerManager; task: WorkerTask } {
    if (this.hasTask(input.id ?? "")) {
      throw new WorkerTaskDuplicateError(input.id ?? "");
    }
    const task = createWorkerTask(input);
    if (this.tasks.some((candidate) => candidate.id === task.id)) {
      throw new WorkerTaskDuplicateError(task.id);
    }
    const future =
      task.scheduledAt !== undefined && Date.parse(task.scheduledAt) > Date.parse(now);
    const item = createQueueItem({
      id: `qitem-${task.id}`,
      taskId: task.id,
      kind: future ? "delayed" : "priority",
      priority: task.priority,
      status: future ? "delayed" : "pending",
      enqueuedAt: now,
      ...(future && task.scheduledAt !== undefined ? { dequeueAt: task.scheduledAt } : {}),
    });
    const queue = future ? this.delayed : this.pending;
    const { queue: nextQueue } = queue.enqueue(item);
    return {
      manager: this.next(
        future
          ? { tasks: [...this.tasks, task], delayed: nextQueue }
          : { tasks: [...this.tasks, task], pending: nextQueue },
      ),
      task: touchWorkerTask(task, {}),
    };
  }

  /**
   * Advance due delayed/retry items into `pending` (the "due check"). Pure
   * state promotion — no execution happens here.
   */
  advance(now: string): {
    manager: WorkerManager;
    promoted: WorkerTask[];
  } {
    const delayedDue = this.delayed.dequeue(this.delayed.count(), now);
    const retryDue = this.retry.dequeue(this.retry.count(), now);
    if (delayedDue.items.length === 0 && retryDue.items.length === 0) {
      return { manager: this, promoted: [] };
    }
    const promoted: WorkerTask[] = [];
    let pending = this.pending;
    let tasks = this.tasks;
    const promote = (item: { taskId: string; priority: Worker["priority"]; enqueuedAt: string; id: string }): void => {
      const task = tasks.find((candidate) => candidate.id === item.taskId);
      if (task === undefined) return;
      const updated = touchWorkerTask(task, {
        status: "pending",
        scheduledAt: null,
        history: [...task.history, { at: now, kind: "state.change", detail: "promoted" }],
      });
      promoted.push(updated);
      tasks = tasks.map((entry) => (entry.id === updated.id ? updated : entry));
      const queueItem = createQueueItem({
        id: item.id,
        taskId: item.taskId,
        kind: "priority",
        priority: item.priority,
        status: "pending",
        enqueuedAt: item.enqueuedAt,
      });
      pending = pending.enqueue(queueItem).queue;
    };
    for (const item of delayedDue.items) promote(item);
    for (const item of retryDue.items) promote(item);
    return {
      manager: this.next({
        delayed: delayedDue.queue,
        retry: retryDue.queue,
        pending,
        tasks,
      }),
      promoted,
    };
  }

  /**
   * Lease the next due, dependency-ready task to `workerId` (successor).
   * Returns `undefined` when no task is selectable.
   */
  leaseTask(
    workerId: string,
    now: string,
    options: SelectOptions = {},
  ): { manager: WorkerManager; task: WorkerTask; lease: WorkerLease; execution: WorkerExecution } | undefined {
    const worker = this.find(workerId);
    if (worker === undefined) return undefined;
    if (!isWorkerAvailable(worker, now)) return undefined;
    const selected = selectNextItem(this.pending.items, this.tasks, now, options);
    if (selected === undefined) return undefined;
    return this.assignTask(workerId, selected.taskId, now);
  }

  /** Lease a specific pending task to a worker (successor). */
  assignTask(
    workerId: string,
    taskId: string,
    now: string,
  ): { manager: WorkerManager; task: WorkerTask; lease: WorkerLease; execution: WorkerExecution } {
    const worker = this.require(workerId);
    if (!isWorkerAvailable(worker, now)) {
      throw new WorkerUnavailableError(workerId);
    }
    const task = this.requireTask(taskId);
    if (task.status !== "pending") {
      throw new Error(`Task "${taskId}" is not pending (status: ${task.status})`);
    }
    const item = this.pending.findByTask(taskId);
    if (item === undefined) {
      throw new Error(`Task "${taskId}" is not queued in pending`);
    }
    const attempts = task.attempts + 1;
    const leased = touchWorkerTask(task, {
      status: "leased",
      attempts,
      startedAt: now,
      history: [...task.history, { at: now, kind: "task.leased" }],
    });
    const busy = this.registry.replace(
      touchWorker(worker, {
        status: "busy",
        state: "busy",
        capacity: { busy: worker.capacity.busy + 1 },
        updatedAt: now,
      }),
    );
    const lease = createWorkerLease({
      taskId,
      workerId,
      acquiredAt: now,
      expiresAt: new Date(Date.parse(now) + this.configuration.leaseDurationMs).toISOString(),
    });
    const execution = createWorkerExecution({
      taskId,
      workerId,
      attempt: attempts,
      startedAt: now,
    });
    return {
      manager: this.next({
        registry: busy.registry,
        pending: this.pending.remove(item.id),
        tasks: this.tasks.map((entry) => (entry.id === taskId ? leased : entry)),
        leases: [...this.leases, lease],
        executions: [...this.executions, execution],
      }),
      task: touchWorkerTask(leased, {}),
      lease: { ...lease },
      execution: { ...execution },
    };
  }

  /** Release an active lease: the task returns to `pending` (successor). */
  releaseTask(
    taskId: string,
    workerId: string,
    now: string,
  ): { manager: WorkerManager; task: WorkerTask } {
    const task = this.requireTask(taskId);
    const lease = this.leases.find(
      (entry) => entry.taskId === taskId && entry.workerId === workerId && entry.status === "active",
    );
    if (lease === undefined) {
      throw new Error(`No active lease for task "${taskId}" on worker "${workerId}"`);
    }
    const worker = this.require(workerId);
    const releasedLease = { ...lease, status: "released" as const };
    const pendingTask = touchWorkerTask(task, {
      status: "pending",
      history: [...task.history, { at: now, kind: "lease.expired", detail: "released" }],
    });
    const item = createQueueItem({
      id: lease.id,
      taskId,
      kind: "priority",
      priority: pendingTask.priority,
      status: "pending",
      enqueuedAt: lease.acquiredAt,
    });
    const freed = this.registry.replace(
      touchWorker(worker, {
        capacity: { busy: Math.max(0, worker.capacity.busy - 1) },
        state: worker.capacity.busy - 1 <= 0 ? "idle" : "busy",
        status: worker.capacity.busy - 1 <= 0 ? "idle" : "busy",
        updatedAt: now,
      }),
    );
    const pending = this.removeQueueItems(this.pending, taskId).enqueue(item).queue;
    return {
      manager: this.next({
        leases: this.leases.map((entry) => (entry.id === lease.id ? releasedLease : entry)),
        tasks: this.tasks.map((entry) => (entry.id === taskId ? pendingTask : entry)),
        pending,
        registry: freed.registry,
      }),
      task: touchWorkerTask(pendingTask, {}),
    };
  }

  /** Settle a task as completed (successor). */
  completeTask(
    taskId: string,
    workerId: string,
    now: string,
    output?: unknown,
    durationMs?: number,
  ): { manager: WorkerManager; task: WorkerTask } {
    const task = this.requireTask(taskId);
    const lease = this.leases.find(
      (entry) =>
        entry.taskId === taskId &&
        entry.workerId === workerId &&
        entry.status === "active",
    );
    const completed = touchWorkerTask(task, {
      status: "completed",
      completedAt: now,
      error: null,
      result: {
        taskId,
        status: "completed",
        ...(output !== undefined ? { output } : {}),
        durationMs: durationMs ?? 0,
        attemptsMade: task.attempts,
      },
      history: [...task.history, { at: now, kind: "task.completed" }],
    });
    return {
      manager: this.next({
        tasks: this.tasks.map((entry) => (entry.id === taskId ? completed : entry)),
        leases: this.leases.map((entry) =>
          entry.id === lease?.id ? { ...entry, status: "completed" as const } : entry,
        ),
        executions: this.finalizeExecution(taskId, workerId, now, {
          status: "completed",
          output,
          durationMs,
        }),
        ...this.freeSlot(workerId, now),
        ...(this.isQueuedTask(task.status)
          ? {
              pending: this.removeQueueItems(this.pending, taskId),
              delayed: this.removeQueueItems(this.delayed, taskId),
              retry: this.removeQueueItems(this.retry, taskId),
            }
          : {}),
      }),
      task: touchWorkerTask(completed, {}),
    };
  }

  /**
   * Settle a task as failed (successor). When the task still has attempts
   * left it moves to the `retry` queue (delayed by the retry policy);
   * otherwise it is dead-lettered.
   */
  failTask(
    taskId: string,
    workerId: string,
    now: string,
    error: WorkerError,
    durationMs?: number,
  ): { manager: WorkerManager; task: WorkerTask } {
    const task = this.requireTask(taskId);
    const lease = this.leases.find(
      (entry) =>
        entry.taskId === taskId &&
        entry.workerId === workerId &&
        entry.status === "active",
    );
    const retryPolicy = task.retryPolicy;
    const attemptsLeft = task.maxAttempts - task.attempts;
    const retryable =
      retryPolicy !== undefined &&
      attemptsLeft > 0 &&
      (retryPolicy.retryableCodes === undefined ||
        retryPolicy.retryableCodes.includes(error.code));

    let retry = this.retry;
    let pending = this.pending;
    let delayed = this.delayed;
    let deadLetter = this.deadLetter;
    let status: WorkerTaskStatus;
    if (retryable) {
      status = "retrying";
      const delay = retryDelayFor(
        retryPolicy?.backoffMs ?? 0,
        task.attempts,
        retryPolicy?.maxDelayMs,
      );
      const item = createQueueItem({
        id: lease?.id ?? `qitem-${taskId}`,
        taskId,
        kind: "retry",
        priority: task.priority,
        status: "retrying",
        enqueuedAt: now,
        dequeueAt: new Date(Date.parse(now) + delay).toISOString(),
        attempt: task.attempts,
      });
      retry = retry.enqueue(item).queue;
    } else {
      status = "dead";
      const entry = createDeadLetterEntry({
        taskId,
        workerId,
        attempts: task.attempts,
        failedAt: now,
        error,
      });
      deadLetter = deadLetter.add(entry).queue;
      pending = this.removeQueueItems(pending, taskId);
      delayed = this.removeQueueItems(delayed, taskId);
    }
    const failed = touchWorkerTask(task, {
      status,
      error,
      completedAt: null,
      history: [
        ...task.history,
        { at: now, kind: status === "retrying" ? "task.retried" : "task.dead", detail: error.code },
      ],
    });
    return {
      manager: this.next({
        tasks: this.tasks.map((entry) => (entry.id === taskId ? failed : entry)),
        leases: this.leases.map((entry) =>
          entry.id === lease?.id ? { ...entry, status: "failed" as const } : entry,
        ),
        executions: this.finalizeExecution(taskId, workerId, now, {
          status: "failed",
          error,
          durationMs,
        }),
        ...this.freeSlot(workerId, now),
        retry,
        pending,
        delayed,
        deadLetter,
      }),
      task: touchWorkerTask(failed, {}),
    };
  }

  /** Settle a task as cancelled (successor); removes it from every queue. */
  cancelTask(
    taskId: string,
    now: string,
    error?: WorkerError,
  ): { manager: WorkerManager; task: WorkerTask } {
    const task = this.requireTask(taskId);
    const lease = this.leases.find((entry) => entry.taskId === taskId && entry.status === "active");
    const cancelled = touchWorkerTask(task, {
      status: "cancelled",
      ...(error !== undefined ? { error } : {}),
      history: [...task.history, { at: now, kind: "task.cancelled" }],
    });
    const cancelExecution = this.executions.map((entry) =>
      entry.taskId === taskId && entry.status === "running"
        ? {
            ...entry,
            status: "cancelled" as const,
            finishedAt: now,
            ...(error !== undefined ? { error } : {}),
          }
        : entry,
    );
    const leaseUpdate = this.leases.map((entry) =>
      entry.id === lease?.id ? { ...entry, status: "cancelled" as const } : entry,
    );
    const workerRelease =
      lease !== undefined ? this.freeSlot(lease.workerId, now) : {};
    return {
      manager: this.next({
        tasks: this.tasks.map((entry) => (entry.id === taskId ? cancelled : entry)),
        leases: leaseUpdate,
        executions: cancelExecution,
        ...workerRelease,
        ...(this.isQueuedTask(task.status)
          ? {
              pending: this.removeQueueItems(this.pending, taskId),
              delayed: this.removeQueueItems(this.delayed, taskId),
              retry: this.removeQueueItems(this.retry, taskId),
            }
          : {}),
      }),
      task: touchWorkerTask(cancelled, {}),
    };
  }

  /** Manually re-queue a retrying/dead task into `pending` (successor). */
  retryTask(taskId: string, now: string): { manager: WorkerManager; task: WorkerTask } {
    const task = this.requireTask(taskId);
    if (task.status !== "retrying" && task.status !== "dead") {
      return { manager: this, task: touchWorkerTask(task, {}) };
    }
    const updated = touchWorkerTask(task, {
      status: "pending",
      error: null,
      history: [...task.history, { at: now, kind: "task.retried", detail: "manual replay" }],
    });
    const item = createQueueItem({
      id: `qitem-${taskId}-replay`,
      taskId,
      kind: "priority",
      priority: task.priority,
      status: "pending",
      enqueuedAt: now,
    });
    return {
      manager: this.next({
        tasks: this.tasks.map((entry) => (entry.id === taskId ? updated : entry)),
        retry: this.removeQueueItems(this.retry, taskId),
        pending: this.pending.enqueue(item).queue,
        deadLetter: this.deadLetter.removeTask(taskId),
      }),
      task: touchWorkerTask(updated, {}),
    };
  }

  /** Mark a leased task as running (called by the executor before work). */
  markRunning(taskId: string, now: string): { manager: WorkerManager; task: WorkerTask } {
    const task = this.requireTask(taskId);
    if (task.status !== "leased") return { manager: this, task: touchWorkerTask(task, {}) };
    const updated = touchWorkerTask(task, {
      status: "running",
      history: [...task.history, { at: now, kind: "state.change", detail: "running" }],
    });
    return {
      manager: this.next({ tasks: this.tasks.map((entry) => (entry.id === taskId ? updated : entry)) }),
      task: touchWorkerTask(updated, {}),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Recovery / maintenance.
  // ─────────────────────────────────────────────────────────────

  /**
   * Expire every lease whose `expiresAt` has passed: the lease is marked
   * `expired`, the worker slot freed, the execution cancelled, and the task
   * returned to `pending` (automatic recovery).
   */
  expireLeases(now: string): { manager: WorkerManager; expired: WorkerLease[] } {
    const expired = this.leases.filter(
      (lease) => lease.status === "active" && Date.parse(lease.expiresAt) <= Date.parse(now),
    );
    if (expired.length === 0) return { manager: this, expired: [] };
    let tasks = this.tasks;
    let executions = this.executions;
    let leases = this.leases;
    let registry = this.registry;
    let pending = this.pending;
    const collected: WorkerLease[] = [];
    for (const lease of expired) {
      const worker = registry.find(lease.workerId);
      leases = leases.map((entry) =>
        entry.id === lease.id ? { ...entry, status: "expired" as const } : entry,
      );
      executions = executions.map((entry) =>
        entry.taskId === lease.taskId && entry.workerId === lease.workerId && entry.status === "running"
          ? {
              ...entry,
              status: "cancelled" as const,
              finishedAt: now,
              error: { code: "lease_expired", message: "Lease expired before completion" },
            }
          : entry,
      );
      const task = tasks.find((entry) => entry.id === lease.taskId);
      if (task !== undefined) {
        const updated = touchWorkerTask(task, {
          status: "pending",
          history: [...task.history, { at: now, kind: "lease.expired" }],
        });
        tasks = tasks.map((entry) => (entry.id === lease.taskId ? updated : entry));
        const item = createQueueItem({
          id: lease.id,
          taskId: lease.taskId,
          kind: "priority",
          priority: updated.priority,
          status: "pending",
          enqueuedAt: lease.acquiredAt,
        });
        pending = this.removeQueueItems(pending, lease.taskId).enqueue(item).queue;
      }
      if (worker !== undefined) {
        const freed = touchWorker(worker, {
          capacity: { busy: Math.max(0, worker.capacity.busy - 1) },
          state: worker.capacity.busy - 1 <= 0 ? "idle" : "busy",
          status: worker.capacity.busy - 1 <= 0 ? "idle" : "busy",
          updatedAt: now,
        });
        registry = registry.replace(freed).registry;
      }
      collected.push({ ...lease });
    }
    return {
      manager: this.next({ leases, executions, tasks, registry, pending }),
      expired: collected,
    };
  }

  /**
   * Cleanup: expire stale leases and prune settled tasks/dead-letter entries
   * older than `retentionMs`. Deterministic given `now`.
   */
  cleanup(
    now: string,
    retentionMs = DEFAULT_CLEANUP_RETENTION_MS,
  ): {
    manager: WorkerManager;
    expired: WorkerLease[];
    removed: WorkerTask[];
  } {
    const { manager: afterLeases, expired } = this.expireLeases(now);
    const cutoff = Date.parse(now) - retentionMs;
    const removed = afterLeases.tasks.filter(
      (task) =>
        (task.status === "completed" || task.status === "cancelled" || task.status === "dead") &&
        task.completedAt !== undefined &&
        Date.parse(task.completedAt) < cutoff,
    );
    const removedIds = new Set(removed.map((task) => task.id));
    const deadLetter = afterLeases.deadLetter.expire(now, retentionMs).queue;
    return {
      manager: afterLeases.next({
        tasks: afterLeases.tasks.filter((task) => !removedIds.has(task.id)),
        deadLetter,
      }),
      expired,
      removed: removed.map((task) => touchWorkerTask(task, {})),
    };
  }

  /**
   * Rebalance: lease the next pending task to every idle worker (deterministic
   * worker order). Returns the number of assignments made.
   */
  rebalance(now: string, options: SelectOptions = {}): {
    manager: WorkerManager;
    assigned: number;
  } {
    let state: { manager: WorkerManager; assigned: number } = {
      manager: this,
      assigned: 0,
    };
    for (const worker of this.registry.listIdle(now)) {
      const leased = state.manager.leaseTask(worker.id, now, options);
      if (leased === undefined) break;
      state = { manager: leased.manager, assigned: state.assigned + 1 };
    }
    return { manager: state.manager, assigned: state.assigned };
  }

  /**
   * Scale a pool to `targetSize` workers (successor). Extra workers are
   * removed in registration order; missing workers are registered with
   * deterministic names.
   */
  scalePool(
    pool: string,
    targetSize: number,
    now: string,
    input: Omit<CreateWorkerInput, "name" | "pool" | "createdAt"> = {},
  ): { manager: WorkerManager; added: Worker[]; removed: Worker[] } {
    const safeTarget = Math.max(0, targetSize);
    const current = this.registry.findByPool(pool);
    let registry = this.registry;
    const added: Worker[] = [];
    const removed: Worker[] = [];
    for (let index = current.length; index < safeTarget; index += 1) {
      const worker = createWorker({
        ...input,
        name: `${pool}-worker-${index}`,
        pool,
        createdAt: now,
        limits: { ...this.configuration.limits, ...(input.limits ?? {}) },
        capacity: { ...this.configuration.capacity, ...(input.capacity ?? {}) },
      });
      const result = registry.register(worker);
      registry = result.registry;
      added.push(result.worker);
    }
    if (current.length > safeTarget) {
      const toRemove = current.slice(safeTarget).map((worker) => worker.id);
      for (const workerId of toRemove) {
        const found = registry.find(workerId);
        if (found !== undefined) removed.push(found);
        registry = registry.remove(workerId);
      }
    }
    return { manager: this.next({ registry }), added, removed };
  }

  // ─────────────────────────────────────────────────────────────
  // Bulk operations (atomic — receiver unchanged on failure).
  // ─────────────────────────────────────────────────────────────

  /** Register many workers atomically. */
  bulkRegisterWorkers(inputs: readonly CreateWorkerInput[]): {
    manager: WorkerManager;
    workers: Worker[];
  } {
    let registry = this.registry;
    const workers: Worker[] = [];
    for (const input of inputs) {
      const worker = createWorker({
        ...input,
        limits: { ...this.configuration.limits, ...(input.limits ?? {}) },
        capacity: { ...this.configuration.capacity, ...(input.capacity ?? {}) },
      });
      const result = registry.register(worker);
      registry = result.registry;
      workers.push(result.worker);
    }
    return { manager: this.next({ registry }), workers };
  }

  /** Enqueue many tasks atomically. */
  bulkEnqueueTasks(
    inputs: readonly CreateWorkerTaskInput[],
    now: string,
  ): { manager: WorkerManager; tasks: WorkerTask[] } {
    let state: { manager: WorkerManager; tasks: WorkerTask[] } = {
      manager: this,
      tasks: [],
    };
    for (const input of inputs) {
      const result = state.manager.enqueueTask(input, now);
      state = { manager: result.manager, tasks: [...state.tasks, result.task] };
    }
    return { manager: state.manager, tasks: state.tasks };
  }

  /** Cancel many tasks atomically (missing ids are ignored). */
  bulkCancelTasks(taskIds: readonly string[], now: string): {
    manager: WorkerManager;
    cancelled: WorkerTask[];
  } {
    let state: { manager: WorkerManager; cancelled: WorkerTask[] } = {
      manager: this,
      cancelled: [],
    };
    for (const taskId of taskIds) {
      if (!state.manager.hasTask(taskId)) continue;
      const result = state.manager.cancelTask(taskId, now);
      state = { manager: result.manager, cancelled: [...state.cancelled, result.task] };
    }
    return { manager: state.manager, cancelled: state.cancelled };
  }

  // ─────────────────────────────────────────────────────────────
  // Internal helpers.
  // ─────────────────────────────────────────────────────────────

  /** Detached clone of the stored worker or throw. */
  private require(workerId: string): Worker {
    const worker = this.registry.find(workerId);
    if (worker === undefined) {
      throw new WorkerUnavailableError(workerId);
    }
    return worker;
  }

  /** Detached clone of the stored task or throw. */
  private requireTask(taskId: string): WorkerTask {
    const task = this.findTask(taskId);
    if (task === undefined) {
      throw new WorkerTaskNotFoundError(taskId);
    }
    return task;
  }

  /**
   * Remove every queue item referencing `taskId`. Leased/running tasks were
   * dequeued at lease time, so the scan can be skipped for them.
   */
  private removeQueueItems(queue: WorkerQueue, taskId: string): WorkerQueue {
    const item = queue.findByTask(taskId);
    if (item === undefined) return queue;
    return queue.remove(item.id);
  }

  /** Whether a task may still carry queue items (not leased/running). */
  private isQueuedTask(status: WorkerTaskStatus): boolean {
    return status !== "leased" && status !== "running";
  }

  /**
   * Free one busy slot of a worker (state derived from remaining slots).
   *
   * Only the running states (`idle`/`busy`) are recomputed: `stopped`,
   * `failed` and `removed` workers keep their lifecycle status — a slot
   * freed by a late task settlement must never resurrect a stopped worker.
   */
  private freeSlot(workerId: string, now: string): { registry: WorkerRegistry } {
    const worker = this.registry.find(workerId);
    if (worker === undefined) return { registry: this.registry };
    const busy = Math.max(0, worker.capacity.busy - 1);
    const terminal = worker.status === "stopped" || worker.status === "failed";
    const nextState: Worker["state"] = terminal
      ? worker.status
      : busy <= 0
        ? "idle"
        : "busy";
    const nextStatus: Worker["status"] = terminal
      ? worker.status
      : busy <= 0
        ? "idle"
        : "busy";
    const { registry } = this.registry.replace(
      touchWorker(worker, {
        capacity: { busy },
        state: nextState,
        status: nextStatus,
        updatedAt: now,
      }),
    );
    return { registry };
  }

  /** Finalize the running execution of `taskId`+`workerId`. */
  private finalizeExecution(
    taskId: string,
    workerId: string,
    now: string,
    settle: {
      status: "completed" | "failed";
      output?: unknown;
      error?: WorkerError;
      durationMs?: number;
    },
  ): readonly WorkerExecution[] {
    const index = this.executions.findIndex(
      (entry) =>
        entry.taskId === taskId &&
        entry.workerId === workerId &&
        entry.status === "running",
    );
    if (index === -1) return this.executions;
    const current = this.executions[index];
    if (current === undefined) return this.executions;
    const finalized: WorkerExecution = {
      ...current,
      status: settle.status,
      finishedAt: now,
      ...(settle.output !== undefined ? { output: settle.output } : {}),
      ...(settle.error !== undefined ? { error: settle.error } : {}),
      ...(settle.durationMs !== undefined ? { durationMs: settle.durationMs } : {}),
    };
    const next = [...this.executions];
    next[index] = finalized;
    return next;
  }
}

/** Build a fresh worker manager (dependency-injected). */
export function createWorkerManager(options: WorkerManagerOptions = {}): WorkerManager {
  return new WorkerManager(options);
}

/** Build a fresh worker manager with a custom configuration. */
export function createConfiguredWorkerManager(
  configuration: CreateWorkerConfigurationInput,
): WorkerManager {
  return new WorkerManager({ configuration: createWorkerConfiguration(configuration) });
}
