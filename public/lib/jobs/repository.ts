/**
 * Background AI Jobs — immutable in-memory job repository.
 *
 * `JobRepository` is the storage facade of the background jobs layer: a
 * private, immutable collection of `Job` objects held in insertion order.
 * Every mutation returns a NEW repository — the original is never changed —
 * so the repository is safe to share and trivial to reason about.
 *
 * Guarantees:
 * - **Constructor snapshot**: the initial jobs are copied on entry; later
 *   caller mutation of those objects never affects the repository.
 * - **Detached clones**: every stored job is deep-frozen internally, and
 *   every read returns a fresh detached clone, so callers can never reach
 *   (or corrupt) the internal collection.
 * - **Insertion order**: `list()` returns jobs in creation order;
 *   `update`/`replace` keep a job's position; `remove` removes it.
 * - **Scheduling queries**: `findScheduledJobs(now)` returns the pending,
 *   non-archived jobs *with* a schedule that are due at `now`;
 *   `findRunnableJobs(now)` additionally includes pending, non-archived
 *   jobs without a schedule (manual/startup/shutdown jobs).
 * - **No caching, no singleton, no timers, no storage, no database**.
 *
 * All operations are deterministic: identical operation sequences produce
 * deep-equal repository states.
 */

import { AppError } from "@/lib/errors";
import {
  cloneJob,
  freezeJob,
  isDue,
  touchJob,
  type Job,
  type JobPatch,
  type JobPriority,
  type JobStatus,
  type JobTrigger,
} from "./types";

/** Raised when an operation targets a job id that is not stored. */
export class JobNotFoundError extends AppError {
  constructor(jobId: string) {
    super(`Job not found: ${jobId}`, 404, "job_not_found");
  }
}

/** Raised when a job is added with an id that is already stored. */
export class JobDuplicateError extends AppError {
  constructor(jobId: string) {
    super(`Job already exists: ${jobId}`, 409, "job_duplicate_id");
  }
}

/**
 * Immutable in-memory collection of jobs.
 *
 * All methods are pure with respect to the repository: reads never mutate,
 * and mutations return the successor repository without touching `this`.
 */
export class JobRepository {
  /** The stored jobs, oldest first, deep-frozen. */
  private readonly jobs: readonly Job[];

  /**
   * Build a repository from an initial set of jobs.
   *
   * Every job is copied (detached from the caller) and deep-frozen; the
   * internal array itself is frozen. Insertion order of the input is
   * preserved.
   */
  constructor(initialJobs: readonly Job[] = []) {
    this.jobs = Object.freeze(initialJobs.map((job) => freezeJob(cloneJob(job))));
  }

  /**
   * Store a new job (appended at the end). Throws `JobDuplicateError` for an
   * already-stored id. Returns the stored job plus the successor repository.
   */
  add(job: Job): { job: Job; repository: JobRepository } {
    if (this.has(job.id)) {
      throw new JobDuplicateError(job.id);
    }
    const stored = freezeJob(cloneJob(job));
    return { job: stored, repository: new JobRepository([...this.jobs, stored]) };
  }

  /**
   * Apply a partial patch to the stored job with the given id.
   *
   * Missing patch keys are preserved; `tags`/`executions` are copied; a
   * `null` value clears an optional field. Throws `JobNotFoundError` for
   * unknown ids. Returns the patched job (a new object) plus the successor
   * repository (position preserved).
   */
  update(id: string, patch: JobPatch): { job: Job; repository: JobRepository } {
    const current = this.require(id);
    const updated = touchJob(current, patch);
    return {
      job: cloneJob(updated),
      repository: new JobRepository(
        this.jobs.map((stored) => (stored.id === id ? freezeJob(cloneJob(updated)) : stored)),
      ),
    };
  }

  /**
   * Replace the stored job with the same id by a detached copy of `job`.
   * The job keeps its insertion position. Throws `JobNotFoundError` for
   * unknown ids.
   */
  replace(job: Job): JobRepository {
    this.require(job.id);
    return new JobRepository(
      this.jobs.map((stored) => (stored.id === job.id ? freezeJob(cloneJob(job)) : stored)),
    );
  }

  /** Remove the job with the given id. Throws for unknown ids. */
  remove(id: string): JobRepository {
    this.require(id);
    return new JobRepository(this.jobs.filter((job) => job.id !== id));
  }

  /** Return a new, empty repository. The receiver is never modified. */
  clear(): JobRepository {
    return new JobRepository();
  }

  /** Return a detached clone of the stored job, or `undefined`. */
  find(id: string): Job | undefined {
    const stored = this.jobs.find((job) => job.id === id);
    return stored === undefined ? undefined : cloneJob(stored);
  }

  /** Return detached clones of every job with the given status, in order. */
  findByStatus(status: JobStatus): Job[] {
    return this.list().filter((job) => job.status === status);
  }

  /** Return detached clones of every job with the given priority, in order. */
  findByPriority(priority: JobPriority): Job[] {
    return this.list().filter((job) => job.priority === priority);
  }

  /** Return detached clones of every job with the given trigger, in order. */
  findByTrigger(trigger: JobTrigger): Job[] {
    return this.list().filter((job) => job.trigger === trigger);
  }

  /**
   * Return detached clones of the pending, non-archived jobs *with* a
   * schedule that are due at `now`, in insertion order. One-time schedules
   * stay visible here until they run (they are not auto-removed); recurring
   * jobs reappear after being rescheduled by the manager.
   */
  findScheduledJobs(now: string): Job[] {
    return this.list().filter(
      (job) => job.schedule !== undefined && isDue(job, now),
    );
  }

  /**
   * Return detached clones of every job that may run at `now` — pending,
   * non-archived, and due (see `isDue`) — in insertion order. Jobs without a
   * schedule (manual/startup/shutdown triggers) are runnable while pending.
   */
  findRunnableJobs(now: string): Job[] {
    return this.list().filter((job) => isDue(job, now));
  }

  /** Return detached clones of every stored job, in insertion order. */
  list(): Job[] {
    return this.jobs.map(cloneJob);
  }

  /** Whether a job with the given id is stored. */
  has(id: string): boolean {
    return this.jobs.some((job) => job.id === id);
  }

  /** Number of stored jobs. */
  count(): number {
    return this.jobs.length;
  }

  /** Throw `JobNotFoundError` unless the id is stored. */
  private require(id: string): Job {
    const stored = this.jobs.find((job) => job.id === id);
    if (stored === undefined) {
      throw new JobNotFoundError(id);
    }
    return stored;
  }
}
