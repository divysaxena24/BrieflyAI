/**
 * Background AI Jobs — job executor.
 *
 * Executes a job's handler with dependency-injected behavior:
 *
 * - **Handler registry**: handlers are resolved by job id from an immutable
 *   `JobHandlerRegistry` (injected); an unknown job id fails structurally
 *   with code `unknown_job` — it never throws.
 * - **AbortSignal**: an optional whole-run signal cancels pending and
 *   in-flight attempts (`cancelled` status).
 * - **Timeout**: an optional per-attempt timeout aborts a hanging handler
 *   (`failed` with code `timeout`).
 * - **Retries**: retries run only when configured (`maxAttempts > 1`); the
 *   delay between attempts is `metadata.retryDelayMs` (default 0) and is
 *   performed through an injected `sleep` so tests stay deterministic.
 * - **Failure isolation**: a throwing/timing-out handler never fails the
 *   caller — it produces a structured `JobExecutionOutcome` while other
 *   jobs continue unaffected.
 * - **No logging** — execution only.
 *
 * The executor mirrors the `ToolExecutor` conventions: wall-clock durations
 * use `Date.now()` (matching the existing tool layer), while every *time*
 * value handed to handlers (`context.now`) is injected.
 */

import type { Job, JobError, JobExecutionContext } from "./types";

/** A job handler: performs the job's work and returns its output. */
export type JobHandler = (context: JobExecutionContext) => Promise<unknown>;

/** A registered handler entry (id + handler pair). */
export interface JobHandlerEntry {
  readonly id: string;
  readonly handler: JobHandler;
}

/** Outcome of executing a job (final attempt settles the status). */
export interface JobExecutionOutcome {
  readonly jobId: string;
  /** The attempt number that settled the job. */
  readonly attempt: number;
  /** Total attempts made before settling. */
  readonly attemptsMade: number;
  readonly status: "completed" | "failed" | "cancelled";
  /** The handler's output on success. */
  readonly output?: unknown;
  /** Failure/cancellation detail when not completed. */
  readonly error?: JobError;
  /** Wall-clock duration of the whole run in milliseconds. */
  readonly durationMs: number;
}

/** Options accepted by {@link JobExecutor.execute}. */
export interface JobExecuteOptions {
  /** Whole-run cancellation signal. */
  readonly signal?: AbortSignal;
  /** Per-attempt timeout in milliseconds (overrides the job's metadata). */
  readonly timeoutMs?: number;
  /** Injected current time passed to handlers (deterministic). */
  readonly now?: string;
}

/** Options accepted by the {@link JobExecutor} constructor. */
export interface JobExecutorOptions {
  /** Retry-delay sleeper; defaults to a `setTimeout`-based wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Default injected current time; defaults to the wall clock. */
  readonly now?: () => string;
}

/** Error thrown internally when an attempt exceeds its timeout. */
export class JobTimeoutError extends Error {
  constructor(message = "Job execution timed out") {
    super(message);
    this.name = "JobTimeoutError";
  }
}

/** Error thrown internally when an attempt is cancelled via the run signal. */
export class JobCancelledError extends Error {
  constructor(message = "Job execution cancelled") {
    super(message);
    this.name = "JobCancelledError";
  }
}

/**
 * Immutable collection of registered job handlers.
 *
 * `register` and `unregister` return a *new* registry rather than mutating
 * the current one, and `list()` exposes a snapshot — mirroring the
 * `ToolRegistry` conventions.
 */
export class JobHandlerRegistry {
  private readonly entries: ReadonlyMap<string, JobHandler>;

  constructor(handlers: readonly JobHandlerEntry[] = []) {
    const map = new Map<string, JobHandler>();
    for (const entry of handlers) {
      if (map.has(entry.id)) {
        throw new Error(`Job handler registry already contains handler "${entry.id}"`);
      }
      map.set(entry.id, entry.handler);
    }
    this.entries = map;
  }

  /** Return a new registry with `handler` registered under `id`. */
  register(id: string, handler: JobHandler): JobHandlerRegistry {
    if (this.entries.has(id)) {
      throw new Error(`Job handler registry already contains handler "${id}"`);
    }
    return new JobHandlerRegistry([...this.entries.entries()].map(([key, value]) => ({ id: key, handler: value })).concat({ id, handler }));
  }

  /** Return a new registry without the handler `id` (no-op when absent). */
  unregister(id: string): JobHandlerRegistry {
    if (!this.entries.has(id)) return this;
    return new JobHandlerRegistry(
      [...this.entries.entries()]
        .filter(([key]) => key !== id)
        .map(([key, value]) => ({ id: key, handler: value })),
    );
  }

  /** Look up a handler by id; `undefined` when not registered. */
  get(id: string): JobHandler | undefined {
    return this.entries.get(id);
  }

  /** Whether a handler with `id` is registered. */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Snapshot of the registered handlers in registration order. */
  list(): readonly JobHandlerEntry[] {
    return [...this.entries.entries()].map(([id, handler]) => ({ id, handler }));
  }
}

/** The default retry-delay sleeper (real time — overridable in tests). */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Executes job handlers with timeout, cancellation, and retry support.
 */
export class JobExecutor {
  private readonly registry: JobHandlerRegistry;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => string;

  constructor(registry: JobHandlerRegistry, options: JobExecutorOptions = {}) {
    this.registry = registry;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Execute `job` and return one structured outcome.
   *
   * - Resolves the handler by `job.id`; an unknown id yields a `failed`
   *   outcome with code `unknown_job`.
   * - Runs up to `job.maxAttempts` attempts (no retries unless configured).
   *   A failed attempt retries after `metadata.retryDelayMs` (via the
   *   injected `sleep`); a cancelled run stops immediately.
   * - The job is never mutated; each execution is independent and
   *   deterministic for identical jobs, handlers, and injected time.
   */
  async execute(job: Job, options: JobExecuteOptions = {}): Promise<JobExecutionOutcome> {
    const startedAt = Date.now();
    const handler = this.registry.get(job.id);
    if (handler === undefined) {
      return {
        jobId: job.id,
        attempt: 1,
        attemptsMade: 1,
        status: "failed",
        error: { code: "unknown_job", message: `No handler registered for job "${job.id}"` },
        durationMs: Date.now() - startedAt,
      };
    }

    if (options.signal?.aborted) {
      return {
        jobId: job.id,
        attempt: 1,
        attemptsMade: 0,
        status: "cancelled",
        error: { code: "cancelled", message: "Job was cancelled before execution" },
        durationMs: Date.now() - startedAt,
      };
    }

    const maxAttempts = Math.max(1, job.maxAttempts);
    const timeoutMs = options.timeoutMs ?? job.metadata.timeoutMs;
    const retryDelayMs = job.metadata.retryDelayMs ?? 0;
    const now = options.now ?? this.now();

    let lastError: JobError | undefined;
    let attemptsMade = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (options.signal?.aborted) {
        return {
          jobId: job.id,
          attempt,
          attemptsMade,
          status: "cancelled",
          error: { code: "cancelled", message: "Job was cancelled" },
          durationMs: Date.now() - startedAt,
        };
      }

      attemptsMade = attempt;
      const context: JobExecutionContext = { job, attempt, signal: options.signal, now };

      try {
        const output = await this.runAttempt(handler, context, timeoutMs, options.signal);
        return {
          jobId: job.id,
          attempt,
          attemptsMade,
          status: "completed",
          output,
          durationMs: Date.now() - startedAt,
        };
      } catch (err) {
        if (err instanceof JobCancelledError) {
          return {
            jobId: job.id,
            attempt,
            attemptsMade,
            status: "cancelled",
            error: { code: "cancelled", message: err.message },
            durationMs: Date.now() - startedAt,
          };
        }
        lastError =
          err instanceof JobTimeoutError
            ? { code: "timeout", message: `Job timed out after ${timeoutMs ?? 0}ms` }
            : {
                code: "handler_error",
                message: err instanceof Error ? err.message : String(err),
              };
        if (attempt < maxAttempts) {
          await this.sleep(retryDelayMs);
        }
      }
    }

    return {
      jobId: job.id,
      attempt: maxAttempts,
      attemptsMade,
      status: "failed",
      error: lastError,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Run a single attempt, racing the handler against the per-attempt timeout
   * and the run's cancellation signal. When neither is configured, await
   * directly. A handler that throws synchronously is caught here and
   * isolated like any other failure.
   */
  private async runAttempt(
    handler: JobHandler,
    context: JobExecutionContext,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const execution = Promise.resolve().then(() => handler(context));

    if (timeoutMs === undefined && signal === undefined) return execution;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectOutcome: (reason: JobTimeoutError | JobCancelledError) => void = () => undefined;
    const outcome = new Promise<never>((_, reject) => {
      rejectOutcome = reject;
    });

    const onExternalAbort = (): void => rejectOutcome(new JobCancelledError());
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => rejectOutcome(new JobTimeoutError()), timeoutMs);
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
