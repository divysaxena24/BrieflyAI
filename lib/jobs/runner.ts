/**
 * Background AI Jobs — background runner (pure orchestration).
 *
 * The runner composes the immutable `JobManager`, the pure
 * `BackgroundScheduler`, and the dependency-injected `JobExecutor` into a
 * deterministic execution loop:
 *
 * ```text
 * BackgroundScheduler → JobExecutor → JobManager (state transitions)
 * ```
 *
 * Higher-level composition (Memory Engine, Conversation Engine, Context
 * Engine, Tool Executor, Digest Builder, Workflow Engine) happens inside the
 * *handlers* registered with the executor — the runner stays engine-agnostic
 * and injectable.
 *
 * Guarantees:
 * - **Priority order**: due jobs run in deterministic priority order (see
 *   `orderDueJobs`), one after another.
 * - **Failure isolation**: a failing job never stops the pass; independent
 *   jobs continue.
 * - **Recurring rescheduling**: a *completed* recurring job is re-armed to
 *   its next occurrence (strictly after the current time); failed or
 *   cancelled recurring jobs are left settled (no infinite failure loops).
 * - **Determinism**: identical managers, executors, handlers, and injected
 *   times produce identical results.
 * - **Immutability**: every run returns the successor runner over the
 *   successor manager; the receiver is never mutated. `stop`/`resume`
 *   return stopped/resumed successor runners.
 *
 * No timers and no polling loops live here — the caller drives `runOnce` /
 * `runUntilEmpty` / `runScheduled` / `runManual` and supplies the time.
 */

import { BackgroundScheduler } from "./scheduler";
import { JobExecutor, type JobExecutionOutcome } from "./executor";
import { JobManager } from "./manager";
import {
  createJobReference,
  isRecurringSchedule,
  type Job,
  type JobError,
  type JobReference,
  type JobStatus,
  type JobTrigger,
} from "./types";

/** Outcome of executing one job in a pass. */
export interface JobRunResult {
  /** Stable reference to the job that ran. */
  readonly reference: JobReference;
  /** The job's final status after the pass. */
  readonly status: Exclude<JobStatus, "pending" | "running">;
  /** The executor attempt number that settled the job. */
  readonly attempt: number;
  /** The handler's output on completion. */
  readonly output?: unknown;
  /** Failure/cancellation detail when not completed. */
  readonly error?: JobError;
}

/** Aggregated outcome of a runner pass. */
export interface RunSummary {
  /** One result per executed job, in execution order. */
  readonly executed: readonly JobRunResult[];
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}

/** Options accepted by the {@link JobRunner} constructor. */
export interface JobRunnerOptions {
  /** Injected current-time source; defaults to the wall clock. */
  readonly now?: () => string;
  /** Initial stopped state; defaults to false (running). */
  readonly stopped?: boolean;
}

/** Build an empty run summary. */
function emptySummary(): RunSummary {
  return { executed: [], total: 0, completed: 0, failed: 0, cancelled: 0 };
}

/** Build a run summary from executed results. */
function summarize(results: readonly JobRunResult[]): RunSummary {
  return {
    executed: results,
    total: results.length,
    completed: results.filter((result) => result.status === "completed").length,
    failed: results.filter((result) => result.status === "failed").length,
    cancelled: results.filter((result) => result.status === "cancelled").length,
  };
}

/** Triggers considered "scheduled" for `runScheduled`. */
const SCHEDULED_TRIGGERS: readonly JobTrigger[] = [
  "scheduled",
  "recurring",
  "startup",
  "shutdown",
];

/**
 * Deterministic orchestration over a `JobManager` and a `JobExecutor`.
 */
export class JobRunner {
  /** The backing immutable manager (never replaced in place). */
  readonly manager: JobManager;

  private readonly executor: JobExecutor;
  private readonly stopped: boolean;
  private readonly now: () => string;

  constructor(manager: JobManager, executor: JobExecutor, options: JobRunnerOptions = {}) {
    this.manager = manager;
    this.executor = executor;
    this.stopped = options.stopped ?? false;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Whether this runner is stopped (skips execution until resumed). */
  isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Return the successor runner with the stopped flag set. The receiver is
   * never mutated.
   */
  stop(): JobRunner {
    return new JobRunner(this.manager, this.executor, { now: this.now, stopped: true });
  }

  /**
   * Return the successor runner with the stopped flag cleared. The receiver
   * is never mutated.
   */
  resume(): JobRunner {
    return new JobRunner(this.manager, this.executor, { now: this.now, stopped: false });
  }

  /**
   * Execute every job due at `now` exactly once, in deterministic priority
   * order. A stopped runner skips execution (empty summary). An optional
   * `signal` is forwarded to the executor for whole-pass cancellation.
   * Returns the successor runner plus the run summary.
   */
  async runOnce(
    now?: string,
    signal?: AbortSignal,
  ): Promise<{ runner: JobRunner; summary: RunSummary }> {
    const at = now ?? this.now();
    if (this.stopped) return { runner: this, summary: emptySummary() };
    const due = new BackgroundScheduler(this.manager.repository).poll(at);
    return this.executeDue(due, at, signal);
  }

  /**
   * Execute every job due at `now`, repeating passes until a pass executes
   * nothing. Equivalent to `runUntilEmpty`; the default entry point.
   *
   * Termination is guaranteed: completed recurring jobs are rescheduled
   * strictly into the future, so the second pass executes nothing.
   */
  async run(now?: string, signal?: AbortSignal): Promise<{ runner: JobRunner; summary: RunSummary }> {
    return this.runUntilEmpty(now, signal);
  }

  /**
   * Execute passes until a pass executes nothing (or the runner stops).
   * Returns the successor runner plus the aggregated summary.
   */
  async runUntilEmpty(
    now?: string,
    signal?: AbortSignal,
  ): Promise<{ runner: JobRunner; summary: RunSummary }> {
    let manager = this.manager;
    const results: JobRunResult[] = [];
    for (;;) {
      const runner = new JobRunner(manager, this.executor, {
        now: this.now,
        stopped: this.stopped,
      });
      const pass = await runner.runOnce(now, signal);
      manager = pass.runner.manager;
      results.push(...pass.summary.executed);
      if (pass.summary.total === 0) break;
    }
    return {
      runner: new JobRunner(manager, this.executor, { now: this.now, stopped: this.stopped }),
      summary: summarize(results),
    };
  }

  /**
   * Execute every due *scheduled* job (scheduled/recurring/startup/shutdown
   * triggers) at `now` exactly once. Manual jobs are excluded.
   */
  async runScheduled(
    now?: string,
    signal?: AbortSignal,
  ): Promise<{ runner: JobRunner; summary: RunSummary }> {
    const at = now ?? this.now();
    if (this.stopped) return { runner: this, summary: emptySummary() };
    const due = new BackgroundScheduler(this.manager.repository)
      .poll(at)
      .filter((job) => SCHEDULED_TRIGGERS.includes(job.trigger));
    return this.executeDue(due, at, signal);
  }

  /**
   * Execute a specific manual job (or every pending manual job when
   * `reference` is omitted) at `now`. A job that is not stored, not pending,
   * not manual, or archived is skipped gracefully (empty results). Returns
   * the successor runner plus the run summary.
   */
  async runManual(
    reference?: JobReference | string,
    now?: string,
    signal?: AbortSignal,
  ): Promise<{ runner: JobRunner; summary: RunSummary }> {
    const at = now ?? this.now();
    if (this.stopped) return { runner: this, summary: emptySummary() };

    const jobId = typeof reference === "string" ? reference : reference?.jobId;
    let candidates: Job[] = [];
    if (jobId !== undefined) {
      const job = this.manager.find(jobId);
      if (job !== undefined) candidates = [job];
    } else {
      candidates = this.manager.list().filter((job) => job.trigger === "manual");
    }
    const due = candidates.filter(
      (job) => job.trigger === "manual" && job.status === "pending" && !job.archived,
    );
    return this.executeDue(due, at, signal);
  }

  /**
   * Execute `due` jobs one after another in the given (already-ordered)
   * order, committing every state transition to the successor manager.
   *
   * Per job: start → execute → settle. Completed recurring jobs are
   * rescheduled to their next occurrence. A stopped runner breaks out of
   * the pass early.
   */
  private async executeDue(
    due: readonly Job[],
    at: string,
    signal?: AbortSignal,
  ): Promise<{ runner: JobRunner; summary: RunSummary }> {
    let manager = this.manager;
    const results: JobRunResult[] = [];

    for (const job of due) {
      if (this.stopped) break;

      const started = manager.startJob(job.id, { at });
      manager = started.manager;
      const outcome: JobExecutionOutcome = await this.executor.execute(started.job, {
        now: at,
        signal,
      });
      const reference = createJobReference(job);

      if (outcome.status === "completed") {
        const completed = manager.completeJob(job.id, {
          at,
          attempt: outcome.attempt,
          output: outcome.output,
          durationMs: outcome.durationMs,
        });
        manager = completed.manager;
        if (completed.job.schedule !== undefined && isRecurringSchedule(completed.job.schedule)) {
          // Re-arm strictly into the future (deterministic, see
          // `rescheduleJob`); failed/cancelled recurring jobs stay settled.
          const rescheduled = manager.rescheduleJob(job.id, at);
          manager = rescheduled.manager;
        }
        results.push({ reference, status: "completed", attempt: outcome.attempt, output: outcome.output });
      } else if (outcome.status === "failed") {
        const failed = manager.failJob(job.id, {
          at,
          attempt: outcome.attempt,
          error: outcome.error ?? { code: "unknown", message: "Job failed" },
          durationMs: outcome.durationMs,
        });
        manager = failed.manager;
        results.push({ reference, status: "failed", attempt: outcome.attempt, error: outcome.error });
      } else {
        const cancelled = manager.cancelJob(job.id, {
          at,
          attempt: outcome.attempt,
          error: outcome.error,
          durationMs: outcome.durationMs,
        });
        manager = cancelled.manager;
        results.push({ reference, status: "cancelled", attempt: outcome.attempt, error: outcome.error });
      }
    }

    return { runner: new JobRunner(manager, this.executor, { now: this.now, stopped: this.stopped }), summary: summarize(results) };
  }
}
