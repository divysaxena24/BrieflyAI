/**
 * Background AI Jobs — job manager (pure orchestration).
 *
 * The operation-facing facade over `JobRepository`. Every mutation is an
 * immutable step: the receiver is never changed, and each operation returns
 * the successor manager (with the successor repository) plus any artifact it
 * produced (registered/started/patched job).
 *
 * Uses only `JobRepository` — no timers, no scheduler, no executor, no
 * persistence, no database, no AI.
 *
 * Lifecycle: `registerJob` / `scheduleJob` → `startJob` → `completeJob` /
 * `failJob` / `cancelJob`; `retryJob` re-enables a failed/cancelled job;
 * `rescheduleJob` re-arms a completed recurring job; `archiveJob` /
 * `restoreJob` toggle the archived flag that excludes a job from scheduling.
 */

import { JobNotFoundError, JobRepository } from "./repository";
import {
  createExecution,
  createJob,
  isRecurringSchedule,
  nextOccurrence,
  touchJob,
  type CreateJobInput,
  type Job,
  type JobError,
  type JobExecution,
  type JobResult,
  type JobStatus,
} from "./types";

/** Input accepted by {@link JobManager.startJob}. */
export interface StartJobInput {
  /** ISO-8601 UTC timestamp of the run start. */
  readonly at: string;
}

/** Input accepted by {@link JobManager.completeJob}. */
export interface CompleteJobInput {
  /** ISO-8601 UTC timestamp of the completion. */
  readonly at: string;
  /** Executor attempt number that succeeded. */
  readonly attempt?: number;
  /** The job's output. */
  readonly output?: unknown;
  /** Optional human-readable note about the run. */
  readonly message?: string;
  /** Wall-clock duration of the run in milliseconds. */
  readonly durationMs?: number;
}

/** Input accepted by {@link JobManager.failJob}. */
export interface FailJobInput {
  /** ISO-8601 UTC timestamp of the failure. */
  readonly at: string;
  /** Structured failure detail. */
  readonly error: JobError;
  /** Executor attempt number that failed. */
  readonly attempt?: number;
  /** Wall-clock duration of the run in milliseconds. */
  readonly durationMs?: number;
}

/** Input accepted by {@link JobManager.cancelJob}. */
export interface CancelJobInput {
  /** ISO-8601 UTC timestamp of the cancellation. */
  readonly at: string;
  /** Optional structured reason for the cancellation. */
  readonly error?: JobError;
  /** Executor attempt number that was cancelled. */
  readonly attempt?: number;
  /** Wall-clock duration of the run in milliseconds. */
  readonly durationMs?: number;
}

/**
 * Pure in-memory orchestration over a `JobRepository`.
 *
 * The backing repository is exposed as a public readonly field so downstream
 * composition (the scheduler, the runner, production wiring) can read the
 * exact state this manager operates on.
 */
export class JobManager {
  /** The backing immutable repository (never replaced in place). */
  readonly repository: JobRepository;

  /**
   * Build a manager over a repository. When omitted, an empty repository is
   * used.
   */
  constructor(repository: JobRepository = new JobRepository()) {
    this.repository = repository;
  }

  /** Return a detached clone of the stored job, or `undefined`. */
  find(id: string): Job | undefined {
    return this.repository.find(id);
  }

  /** Return detached clones of every stored job, in insertion order. */
  list(): Job[] {
    return this.repository.list();
  }

  /** Whether a job with the given id is stored. */
  has(id: string): boolean {
    return this.repository.has(id);
  }

  /** Number of stored jobs. */
  count(): number {
    return this.repository.count();
  }

  /**
   * Register a new job (built via `createJob` with defaults) and return it
   * plus the successor manager. Throws `JobDuplicateError` for an
   * already-stored id.
   */
  registerJob(input: CreateJobInput): { manager: JobManager; job: Job } {
    const job = createJob(input);
    const { job: stored, repository } = this.repository.add(job);
    return { manager: new JobManager(repository), job: stored };
  }

  /**
   * Register a job with a schedule (the entry point for scheduled and
   * recurring jobs). Identical to `registerJob`; documented separately so
   * callers express intent. Throws `JobDuplicateError` for duplicates.
   */
  scheduleJob(input: CreateJobInput): { manager: JobManager; job: Job } {
    return this.registerJob(input);
  }

  /**
   * Remove the job with the given id entirely. Throws `JobNotFoundError` for
   * unknown ids. Distinct from `cancelJob` (which marks the job cancelled
   * but keeps it stored) and `archiveJob` (which keeps it stored but
   * unschedulable).
   */
  unregisterJob(jobId: string): JobManager {
    return new JobManager(this.repository.remove(jobId));
  }

  /**
   * Mark a job as running: status `"running"`, `startedAt` set, `attempts`
   * incremented, and a `running` execution record appended. Returns the
   * started job (plus its execution) and the successor manager. Throws
   * `JobNotFoundError` for unknown ids.
   */
  startJob(
    jobId: string,
    input: StartJobInput,
  ): { manager: JobManager; job: Job; execution: JobExecution } {
    const current = this.require(jobId);
    const attempts = current.attempts + 1;
    const execution = createExecution({
      jobId,
      attempt: attempts,
      status: "running",
      startedAt: input.at,
    });
    const job = touchJob(current, {
      status: "running",
      attempts,
      startedAt: input.at,
      completedAt: null,
      executions: [...current.executions, execution],
    });
    return { manager: new JobManager(this.repository.replace(job)), job, execution };
  }

  /**
   * Mark a job as completed: status `"completed"`, `completedAt` set, the
   * `running` execution finalized as `completed` with the outcome attached.
   * Throws `JobNotFoundError` for unknown ids.
   */
  completeJob(jobId: string, input: CompleteJobInput): { manager: JobManager; job: Job } {
    const current = this.require(jobId);
    const executions = this.finalizeExecution(current, {
      status: "completed",
      finishedAt: input.at,
      attempt: input.attempt,
      result: {
        success: true,
        ...(input.output !== undefined ? { output: input.output } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      },
      durationMs: input.durationMs,
    });
    const job = touchJob(current, {
      status: "completed",
      completedAt: input.at,
      result: {
        success: true,
        ...(input.output !== undefined ? { output: input.output } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      },
      error: null,
      executions,
    });
    return { manager: new JobManager(this.repository.replace(job)), job };
  }

  /**
   * Mark a job as failed: status `"failed"`, `error` set, the `running`
   * execution finalized as `failed`. Throws `JobNotFoundError` for unknown
   * ids.
   */
  failJob(jobId: string, input: FailJobInput): { manager: JobManager; job: Job } {
    const current = this.require(jobId);
    const executions = this.finalizeExecution(current, {
      status: "failed",
      finishedAt: input.at,
      attempt: input.attempt,
      error: { ...input.error },
      durationMs: input.durationMs,
    });
    const job = touchJob(current, {
      status: "failed",
      error: { ...input.error },
      result: null,
      executions,
    });
    return { manager: new JobManager(this.repository.replace(job)), job };
  }

  /**
   * Mark a job as cancelled: status `"cancelled"`, optional `error` set, the
   * `running` execution finalized as `cancelled`. Throws `JobNotFoundError`
   * for unknown ids.
   */
  cancelJob(jobId: string, input: CancelJobInput): { manager: JobManager; job: Job } {
    const current = this.require(jobId);
    const executions = this.finalizeExecution(current, {
      status: "cancelled",
      finishedAt: input.at,
      attempt: input.attempt,
      ...(input.error !== undefined ? { error: { ...input.error } } : {}),
      durationMs: input.durationMs,
    });
    const job = touchJob(current, {
      status: "cancelled",
      ...(input.error !== undefined ? { error: { ...input.error } } : {}),
      result: null,
      executions,
    });
    return { manager: new JobManager(this.repository.replace(job)), job };
  }

  /**
   * Re-enable a failed or cancelled job for a new run: status `"pending"`,
   * `error` cleared, `result` cleared, `scheduledAt` preserved. Runs already
   * recorded in `executions` are kept. Throws `JobNotFoundError` for unknown
   * ids; jobs that are not failed/cancelled are returned unchanged.
   */
  retryJob(jobId: string): { manager: JobManager; job: Job } {
    const current = this.require(jobId);
    if (current.status !== "failed" && current.status !== "cancelled") {
      return { manager: this, job: current };
    }
    const job = touchJob(current, { status: "pending", error: null, result: null });
    return { manager: new JobManager(this.repository.replace(job)), job };
  }

  /**
   * Re-arm a completed recurring job for its next occurrence: status
   * `"pending"` and `scheduledAt` set to the next occurrence strictly after
   * `now`. Deterministic — `nextOccurrence` derives the timestamp from the
   * schedule alone. Throws `JobNotFoundError` for unknown ids.
   */
  rescheduleJob(
    jobId: string,
    now: string,
  ): { manager: JobManager; job: Job } {
    const current = this.require(jobId);
    if (current.schedule === undefined || !isRecurringSchedule(current.schedule)) {
      return { manager: this, job: current };
    }
    const next = nextOccurrence(current.schedule, now);
    if (next === undefined) {
      return { manager: this, job: current };
    }
    const job = touchJob(current, { status: "pending", scheduledAt: next });
    return { manager: new JobManager(this.repository.replace(job)), job };
  }

  /**
   * Archive a job: sets `archived` so it is excluded from scheduling while
   * remaining stored. Throws `JobNotFoundError` for unknown ids.
   */
  archiveJob(jobId: string): JobManager {
    return new JobManager(this.repository.update(jobId, { archived: true }).repository);
  }

  /**
   * Restore an archived job: clears `archived`. Throws `JobNotFoundError`
   * for unknown ids.
   */
  restoreJob(jobId: string): JobManager {
    return new JobManager(this.repository.update(jobId, { archived: false }).repository);
  }

  /**
   * Register many jobs atomically. Returns the successor manager plus every
   * stored job. Throws `JobDuplicateError` on the first duplicate id (the
   * receiver is unchanged either way).
   */
  bulkRegister(inputs: readonly CreateJobInput[]): {
    manager: JobManager;
    jobs: Job[];
  } {
    let repository = this.repository;
    const jobs: Job[] = [];
    for (const input of inputs) {
      const job = createJob(input);
      const result = repository.add(job);
      repository = result.repository;
      jobs.push(result.job);
    }
    return { manager: new JobManager(repository), jobs };
  }

  /**
   * Cancel many jobs atomically. Throws `JobNotFoundError` on the first
   * unknown id (the receiver is unchanged either way).
   */
  bulkCancel(jobIds: readonly string[]): JobManager {
    let repository = this.repository;
    for (const jobId of jobIds) {
      const current = repository.find(jobId);
      if (current === undefined) {
        throw new JobNotFoundError(jobId);
      }
      const job = touchJob(current, { status: "cancelled" });
      repository = repository.replace(job);
    }
    return new JobManager(repository);
  }

  /** Return a detached clone of the stored job or throw. */
  private require(jobId: string): Job {
    const job = this.repository.find(jobId);
    if (job === undefined) {
      throw new JobNotFoundError(jobId);
    }
    return job;
  }

  /**
   * Build the successor executions list: the most recent `running` execution
   * is replaced by a finalized record carrying `status`, `finishedAt`, and
   * the optional error/result/duration. When the job has no running
   * execution (e.g. a direct settle without `startJob`), the finalized
   * record is appended.
   */
  private finalizeExecution(
    job: Job,
    finalize: {
      status: JobStatus;
      finishedAt: string;
      attempt?: number;
      error?: JobError;
      result?: JobResult;
      durationMs?: number;
    },
  ): readonly JobExecution[] {
    const executions = job.executions;
    const runningIndex = executions.reduce(
      (lastIndex, execution, index) => (execution.status === "running" ? index : lastIndex),
      -1,
    );

    const finalized = createExecution({
      jobId: job.id,
      attempt: finalize.attempt ?? executions[runningIndex]?.attempt ?? job.attempts,
      status: finalize.status,
      startedAt: executions[runningIndex]?.startedAt ?? job.startedAt ?? finalize.finishedAt,
      finishedAt: finalize.finishedAt,
      ...(finalize.error !== undefined ? { error: finalize.error } : {}),
      ...(finalize.result !== undefined ? { result: finalize.result } : {}),
      ...(finalize.durationMs !== undefined ? { durationMs: finalize.durationMs } : {}),
    });

    if (runningIndex === -1) {
      return [...executions, finalized];
    }
    const next = [...executions];
    next[runningIndex] = finalized;
    return next;
  }
}
