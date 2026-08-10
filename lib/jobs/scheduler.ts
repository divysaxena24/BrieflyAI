/**
 * Background AI Jobs — background scheduler (pure, deterministic).
 *
 * The scheduler is a pure state machine over a `JobRepository`: given an
 * injected current time, it reports which jobs are due and in what order.
 * It owns no timers, no `setInterval`, no `setTimeout`, and no cron — the
 * caller drives it (polling/ticking) and supplies the time.
 *
 * - `schedule(job)` / `unschedule(jobId)` maintain the scheduler's own
 *   repository (successor pattern; the receiver is never mutated).
 * - `poll(now)` returns every runnable job at `now` in deterministic order.
 * - `nextRunnable(now)` returns the single highest-priority runnable job.
 * - `tick(now)` / `runDueJobs(now)` are the runner-facing hooks: they return
 *   the due jobs plus the successor scheduler (unchanged — the scheduler is
 *   stateless with respect to time; job state transitions live in the
 *   manager).
 *
 * Deterministic ordering: jobs run by priority (`critical` > `high` >
 * `normal` > `low`); ties are broken by due time (earlier first, using
 * `scheduledAt`, falling back to `createdAt` for schedule-less jobs), then
 * by job id (lexicographic).
 */

import { JobRepository } from "./repository";
import { PRIORITY_RANK, nextOccurrence, type Job, type JobSchedule } from "./types";

/**
 * Deterministically order runnable jobs for execution.
 *
 * Primary key: priority rank (descending). Secondary key: due time
 * (`scheduledAt`, falling back to `createdAt`) ascending. Final tie-break:
 * job id (lexicographic). The input array is never mutated.
 */
export function orderDueJobs(jobs: readonly Job[]): Job[] {
  return [...jobs].sort((left, right) => {
    const priorityDelta = PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority];
    if (priorityDelta !== 0) return priorityDelta;

    const leftDue = left.scheduledAt ?? left.createdAt;
    const rightDue = right.scheduledAt ?? right.createdAt;
    const dueDelta = Date.parse(leftDue) - Date.parse(rightDue);
    if (dueDelta !== 0) return dueDelta;

    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/**
 * A schedule with a deterministic recurrence preview — the upcoming
 * occurrences of a recurring schedule, oldest first.
 *
 * Pure: derived entirely from the schedule and the injected `after` time.
 */
export function previewOccurrences(
  schedule: JobSchedule,
  after: string,
  count: number,
): string[] {
  const occurrences: string[] = [];
  let cursor = after;
  for (let index = 0; index < count; index += 1) {
    const next = nextOccurrence(schedule, cursor);
    if (next === undefined) break;
    // Only strictly-upcoming occurrences are yielded; a one-time schedule
    // repeats its single occurrence forever and a past occurrence is not
    // upcoming, so the loop stops as soon as the cursor makes no progress.
    if (Date.parse(next) <= Date.parse(cursor)) break;
    occurrences.push(next);
    cursor = next;
  }
  return occurrences;
}

/**
 * Pure, deterministic background scheduler.
 *
 * Immutable with respect to its repository: `schedule` and `unschedule`
 * return successor schedulers; every read returns detached clones.
 */
export class BackgroundScheduler {
  /** The backing immutable repository (never replaced in place). */
  readonly repository: JobRepository;

  /**
   * Build a scheduler over a repository. When omitted, an empty repository
   * is used.
   */
  constructor(repository: JobRepository = new JobRepository()) {
    this.repository = repository;
  }

  /**
   * Return a successor scheduler with `job` stored. Throws
   * `JobDuplicateError` for an already-stored id.
   */
  schedule(job: Job): { scheduler: BackgroundScheduler; job: Job } {
    const { job: stored, repository } = this.repository.add(job);
    return { scheduler: new BackgroundScheduler(repository), job: stored };
  }

  /**
   * Return a successor scheduler without the job `jobId`. A no-op returning
   * the same scheduler when no such job is stored. Never mutates `this`.
   */
  unschedule(jobId: string): BackgroundScheduler {
    if (!this.repository.has(jobId)) return this;
    return new BackgroundScheduler(this.repository.remove(jobId));
  }

  /**
   * Every job that may run at `now`, in deterministic execution order
   * (see {@link orderDueJobs}).
   */
  poll(now: string): Job[] {
    return orderDueJobs(this.repository.findRunnableJobs(now));
  }

  /**
   * The single highest-priority job that may run at `now`, or `undefined`
   * when nothing is due.
   */
  nextRunnable(now: string): Job | undefined {
    return this.poll(now)[0];
  }

  /**
   * Advance one scheduling step at `now`: return the due jobs (same as
   * `poll`) plus the successor scheduler. The scheduler itself is
   * time-stateless — job state transitions belong to the manager — so the
   * successor is unchanged; `tick` exists as the runner-facing hook.
   */
  tick(now: string): { scheduler: BackgroundScheduler; due: Job[] } {
    return { scheduler: this, due: this.poll(now) };
  }

  /**
   * Alias of {@link tick}: the runner-facing "execute everything due at
   * `now`" hook. Returns the due jobs (already ordered) plus the successor
   * scheduler.
   */
  runDueJobs(now: string): { scheduler: BackgroundScheduler; due: Job[] } {
    return this.tick(now);
  }
}
