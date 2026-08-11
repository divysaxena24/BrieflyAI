/**
 * Background Worker Infrastructure — worker executor (Phase 6B STEP 7).
 *
 * Executes a single attempt of a worker task through a handler registry
 * (dependency-injected). The executor mirrors the `JobExecutor` conventions:
 *
 * - **Handler registry**: handlers are resolved by task kind from an
 *   immutable `WorkerTaskHandlerRegistry` (injected); an unknown kind fails
 *   structurally with code `unknown_task_kind` — it never throws.
 * - **AbortSignal**: an optional whole-run signal cancels the attempt.
 * - **Timeout**: an optional per-attempt timeout aborts a hanging handler
 *   (`failed` with code `timeout`).
 * - **Failure isolation**: a throwing/timing-out handler never fails the
 *   caller — it produces a structured `WorkerExecutionResult`.
 * - * * No logging** — execution only.
 *
 * Retry orchestration lives in the manager/scheduler (cross-worker retries
 * go through the retry queue); this executor runs exactly one attempt.
 * Wall-clock durations default to `Date.now()` (matching the existing
 * tool/job executors) while every *time* value handed to handlers is
 * injected — inject a fixed `clockMs` for fully deterministic outcomes.
 */

import type {
  WorkerContext,
  WorkerError,
  WorkerExecutionResult,
  WorkerTask,
  WorkerTaskPayload,
} from "./types";

/** A task handler: performs the task's work and returns its output. */
export type WorkerTaskHandler = (
  context: WorkerTaskHandlerContext,
) => Promise<unknown>;

/** Context handed to a task handler. */
export interface WorkerTaskHandlerContext {
  /** The task being executed (never mutated). */
  readonly task: WorkerTask;
  /** The task's typed payload. */
  readonly payload: WorkerTaskPayload;
  /** The worker running the task. */
  readonly workerId: string;
  /** The attempt number of this run. */
  readonly attempt: number;
  /** Injected current time (deterministic). */
  readonly now: string;
  /** Whole-run cancellation signal. */
  readonly signal?: AbortSignal;
}

/** A registered handler entry (kind + handler pair). */
export interface WorkerTaskHandlerEntry {
  readonly kind: WorkerTask["kind"];
  readonly handler: WorkerTaskHandler;
}

/** Outcome of executing one attempt. */
export interface WorkerAttemptOutcome {
  readonly taskId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly output?: unknown;
  readonly error?: WorkerError;
  /** Wall-clock duration of the attempt in milliseconds. */
  readonly durationMs: number;
  /** The attempt number executed. */
  readonly attempt: number;
}

/** Immutable collection of task handlers. */
export class WorkerTaskHandlerRegistry {
  private readonly entries: ReadonlyMap<WorkerTask["kind"], WorkerTaskHandler>;

  constructor(handlers: readonly WorkerTaskHandlerEntry[] = []) {
    const map = new Map<WorkerTask["kind"], WorkerTaskHandler>();
    for (const entry of handlers) {
      if (map.has(entry.kind)) {
        throw new Error(`Worker task handler registry already contains "${entry.kind}"`);
      }
      map.set(entry.kind, entry.handler);
    }
    this.entries = map;
  }

  /** Return a new registry with `handler` registered under `kind`. */
  register(kind: WorkerTask["kind"], handler: WorkerTaskHandler): WorkerTaskHandlerRegistry {
    if (this.entries.has(kind)) {
      throw new Error(`Worker task handler registry already contains "${kind}"`);
    }
    return new WorkerTaskHandlerRegistry([
      ...[...this.entries.entries()].map(([key, value]) => ({ kind: key, handler: value })),
      { kind, handler },
    ]);
  }

  /** Register many handlers at once. */
  registerMany(
    handlers: readonly WorkerTaskHandlerEntry[],
  ): WorkerTaskHandlerRegistry {
    let state: { registry: WorkerTaskHandlerRegistry } = { registry: this };
    for (const entry of handlers) {
      state = { registry: state.registry.register(entry.kind, entry.handler) };
    }
    return state.registry;
  }

  /** Look up a handler by kind; `undefined` when not registered. */
  get(kind: WorkerTask["kind"]): WorkerTaskHandler | undefined {
    return this.entries.get(kind);
  }

  /** Whether a handler for `kind` is registered. */
  has(kind: WorkerTask["kind"]): boolean {
    return this.entries.has(kind);
  }

  /** Snapshot of the registered handlers in registration order. */
  list(): readonly WorkerTaskHandlerEntry[] {
    return [...this.entries.entries()].map(([kind, handler]) => ({ kind, handler }));
  }
}

/** Error thrown internally when an attempt exceeds its timeout. */
export class WorkerTimeoutError extends Error {
  constructor(message = "Worker task timed out") {
    super(message);
    this.name = "WorkerTimeoutError";
  }
}

/** Error thrown internally when an attempt is cancelled via the run signal. */
export class WorkerCancelledError extends Error {
  constructor(message = "Worker task cancelled") {
    super(message);
    this.name = "WorkerCancelledError";
  }
}

/** Options accepted by {@link WorkerExecutor.execute}. */
export interface WorkerExecuteOptions {
  /** The worker running the task. */
  readonly workerId: string;
  /** Injected current time (deterministic). */
  readonly now?: string;
  /** Whole-run cancellation signal. */
  readonly signal?: AbortSignal;
  /** Per-attempt timeout in milliseconds (overrides the task's timeout). */
  readonly timeoutMs?: number;
  /** Lease-renewal hook invoked before the attempt starts. */
  readonly heartbeat?: () => void;
  /** Injected handler context extras. */
  readonly context?: Partial<WorkerContext>;
}

/** Options accepted by the {@link WorkerExecutor} constructor. */
export interface WorkerExecutorOptions {
  /** Injected current-time source; defaults to the wall clock. */
  readonly now?: () => string;
  /**
   * Injected millisecond clock used for `durationMs` measurements; defaults
   * to `Date.now`. Inject a fixed clock to make outcomes deterministic.
   */
  readonly clockMs?: () => number;
}

/**
 * Executes worker task attempts with timeout and cancellation support.
 * Never throws — every outcome is structured.
 */
export class WorkerExecutor {
  private readonly registry: WorkerTaskHandlerRegistry;
  private readonly now: () => string;
  private readonly clockMs: () => number;

  constructor(registry: WorkerTaskHandlerRegistry, options: WorkerExecutorOptions = {}) {
    this.registry = registry;
    this.now = options.now ?? (() => new Date().toISOString());
    this.clockMs = options.clockMs ?? (() => Date.now());
  }

  /**
   * Execute a single attempt of `task` and return the structured outcome.
   *
   * - Resolves the handler by task kind; an unknown kind yields a `failed`
   *   outcome with code `unknown_task_kind`.
   * - A cancelled run (signal already aborted) yields a `cancelled` outcome
   *   without invoking the handler.
   * - The task is never mutated; execution is deterministic for identical
   *   tasks, handlers and injected time.
   */
  async execute(
    task: WorkerTask,
    options: WorkerExecuteOptions,
  ): Promise<WorkerExecutionResult> {
    const startedAt = this.clockMs();
    const handler = this.registry.get(task.kind);
    if (handler === undefined) {
      return {
        taskId: task.id,
        status: "failed",
        error: {
          code: "unknown_task_kind",
          message: `No handler registered for task kind "${task.kind}"`,
        },
        durationMs: this.clockMs() - startedAt,
        attemptsMade: task.attempts,
      };
    }

    if (options.signal?.aborted) {
      return {
        taskId: task.id,
        status: "cancelled",
        error: { code: "cancelled", message: "Task was cancelled before execution" },
        durationMs: this.clockMs() - startedAt,
        attemptsMade: task.attempts,
      };
    }

    const now = options.now ?? this.now();
    const attempt = Math.max(1, task.attempts);
    const context: WorkerTaskHandlerContext = {
      task,
      payload: task.payload,
      workerId: options.workerId,
      attempt,
      now,
      signal: options.signal,
    };

    options.heartbeat?.();

    try {
      const output = await this.runAttempt(handler, context, options.timeoutMs ?? task.timeoutMs, options.signal);
      return {
        taskId: task.id,
        status: "completed",
        output,
        durationMs: this.clockMs() - startedAt,
        attemptsMade: task.attempts,
      };
    } catch (err) {
      if (err instanceof WorkerCancelledError) {
        return {
          taskId: task.id,
          status: "cancelled",
          error: { code: "cancelled", message: err.message },
          durationMs: this.clockMs() - startedAt,
          attemptsMade: task.attempts,
        };
      }
      const timeoutMs = options.timeoutMs ?? task.timeoutMs;
      const error: WorkerError =
        err instanceof WorkerTimeoutError
          ? { code: "timeout", message: `Task timed out after ${timeoutMs ?? 0}ms`, retryable: true }
          : {
              code: "handler_error",
              message: err instanceof Error ? err.message : String(err),
            };
      return {
        taskId: task.id,
        status: "failed",
        error,
        durationMs: this.clockMs() - startedAt,
        attemptsMade: task.attempts,
      };
    }
  }

  /** Execute one attempt of `task`; alias of {@link execute} (attempt-level API). */
  async executeAttempt(
    task: WorkerTask,
    options: WorkerExecuteOptions,
  ): Promise<WorkerAttemptOutcome> {
    const outcome = await this.execute(task, options);
    return {
      taskId: outcome.taskId,
      status: outcome.status,
      ...(outcome.output !== undefined ? { output: outcome.output } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      durationMs: outcome.durationMs,
      attempt: Math.max(1, task.attempts),
    };
  }

  /**
   * Run a single attempt, racing the handler against the per-attempt timeout
   * and the run's cancellation signal. When neither is configured, await
   * directly.
   */
  private async runAttempt(
    handler: WorkerTaskHandler,
    context: WorkerTaskHandlerContext,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const execution = Promise.resolve().then(() => handler(context));

    if (timeoutMs === undefined && signal === undefined) return execution;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectOutcome: (reason: WorkerTimeoutError | WorkerCancelledError) => void = () => undefined;
    const outcome = new Promise<never>((_, reject) => {
      rejectOutcome = reject;
    });

    const onExternalAbort = (): void => rejectOutcome(new WorkerCancelledError());
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => rejectOutcome(new WorkerTimeoutError()), timeoutMs);
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        onExternalAbort();
      } else {
        signal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    return Promise.race([execution, outcome]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    });
  }
}
