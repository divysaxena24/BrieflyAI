/**
 * Background AI Jobs — immutable domain models.
 *
 * Step 1 of the Background AI Jobs framework: the pure, readonly data model
 * for jobs plus the pure helper functions that construct, clone, freeze,
 * touch, schedule, and measure them.
 *
 * No services, no timers, no cron, no external scheduler, no database, no
 * LLM, and no side effects live here — only data and pure functions. Every
 * function is deterministic: identical inputs always produce identical
 * outputs, and caller-supplied objects/arrays are never referenced or
 * mutated (they are copied on entry, and the returned structures are
 * detached).
 *
 * Timestamps are always supplied by the caller (no `Date.now()`) so every
 * operation stays pure and reproducible.
 */

/** Lifecycle state of a job. */
export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped";

/** Execution priority of a job — drives scheduling order. */
export type JobPriority = "low" | "normal" | "high" | "critical";

/** How a job was launched. */
export type JobTrigger = "manual" | "scheduled" | "recurring" | "startup" | "shutdown";

/** Default status assigned by `createJob` when none is provided. */
export const DEFAULT_JOB_STATUS: JobStatus = "pending";

/** Default priority assigned by `createJob` when none is provided. */
export const DEFAULT_JOB_PRIORITY: JobPriority = "normal";

/** Default trigger assigned by `createJob` when none is provided. */
export const DEFAULT_JOB_TRIGGER: JobTrigger = "manual";

/** Default attempt budget assigned by `createJob` (no retries unless configured). */
export const DEFAULT_JOB_MAX_ATTEMPTS = 1;

/** Default archived flag assigned by `createJob`. */
export const DEFAULT_JOB_ARCHIVED = false;

/**
 * Deterministic ordering rank of each priority — higher runs first.
 * `critical` (3) > `high` (2) > `normal` (1) > `low` (0).
 */
export const PRIORITY_RANK: Readonly<Record<JobPriority, number>> = Object.freeze({
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
});

/**
 * Base execution-cost heuristic of each priority, used by
 * `estimateExecutionCost` when a job carries no explicit `costUnits`.
 */
export const PRIORITY_COST: Readonly<Record<JobPriority, number>> = Object.freeze({
  low: 1,
  normal: 2,
  high: 4,
  critical: 8,
});

/**
 * A one-time or recurring schedule.
 *
 * - One-time schedules carry `at` (exactly one occurrence).
 * - Recurring schedules carry `everyMs` (the interval) and `startsAt` (the
 *   first occurrence; `createJob` defaults it to the job's `createdAt`).
 * - A schedule with neither field is treated as never due.
 */
export interface JobSchedule {
  /** ISO-8601 UTC timestamp of the single occurrence (one-time schedules). */
  readonly at?: string;
  /** Interval between occurrences in milliseconds (recurring schedules). */
  readonly everyMs?: number;
  /** ISO-8601 UTC timestamp of the first recurring occurrence. */
  readonly startsAt?: string;
}

/** Structured error attached to a failed or cancelled job. */
export interface JobError {
  /** Stable machine-readable code, e.g. "timeout", "handler_error". */
  readonly code: string;
  /** Human-readable detail. */
  readonly message: string;
}

/** Structured outcome of a completed job run. */
export interface JobResult {
  /** True when the run produced a useful output. */
  readonly success: boolean;
  /** The job's output on success. */
  readonly output?: unknown;
  /** Optional human-readable note about the run. */
  readonly message?: string;
  /** Wall-clock duration of the run in milliseconds. */
  readonly durationMs?: number;
}

/**
 * A single recorded execution of a job.
 *
 * One execution is appended when a job starts and finalized (status,
 * finishedAt, error/result, durationMs) when it settles.
 */
export interface JobExecution {
  /** Stable execution id; deterministic when derived by `createExecution`. */
  readonly id: string;
  /** The job this execution belongs to. */
  readonly jobId: string;
  /** 1-based attempt number within the job's run. */
  readonly attempt: number;
  /** The execution's lifecycle state. */
  readonly status: JobStatus;
  /** ISO-8601 UTC timestamp of the attempt's start. */
  readonly startedAt: string;
  /** ISO-8601 UTC timestamp of the attempt's settlement, when settled. */
  readonly finishedAt?: string;
  /** Structured failure/cancellation detail, when not successful. */
  readonly error?: JobError;
  /** Structured outcome, when the attempt completed. */
  readonly result?: JobResult;
  /** Wall-clock duration of the attempt in milliseconds, when settled. */
  readonly durationMs?: number;
}

/**
 * Structured metadata of a job.
 *
 * `timeoutMs`, `retryDelayMs`, and `costUnits` are execution hints honored by
 * the executor and the pure cost estimator; `tags` are stable labels.
 */
export interface JobMetadata {
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
 * An immutable background job.
 *
 * `status` drives schedulability; `schedule`/`scheduledAt` drive *when* it is
 * due; `attempts` counts started runs; `executions` is the full run history.
 */
export interface Job {
  /** Stable job id; deterministic when derived by `createJob`. */
  readonly id: string;
  /** Human-readable job name. */
  readonly name: string;
  readonly status: JobStatus;
  readonly priority: JobPriority;
  readonly trigger: JobTrigger;
  /** When defined, the job only runs when its schedule is due. */
  readonly schedule?: JobSchedule;
  /** Number of times the job has been started. */
  readonly attempts: number;
  /** Total attempt budget (retries are `maxAttempts − 1`). */
  readonly maxAttempts: number;
  /** ISO-8601 UTC timestamp of the job's creation. */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the next/only scheduled run. */
  readonly scheduledAt?: string;
  /** ISO-8601 UTC timestamp of the most recent start. */
  readonly startedAt?: string;
  /** ISO-8601 UTC timestamp of the most recent completion. */
  readonly completedAt?: string;
  /** When true, the job is excluded from scheduling (see `archiveJob`). */
  readonly archived: boolean;
  /** Structured failure/cancellation detail of the most recent run. */
  readonly error?: JobError;
  /** Structured outcome of the most recent completed run. */
  readonly result?: JobResult;
  readonly metadata: JobMetadata;
  /** Run history, oldest first. */
  readonly executions: readonly JobExecution[];
}

/**
 * Lightweight projection of a job for list/overview views.
 */
export interface JobSummary {
  readonly id: string;
  readonly name: string;
  readonly status: JobStatus;
  readonly priority: JobPriority;
  readonly trigger: JobTrigger;
  /** ISO-8601 UTC timestamp of the job's creation. */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the next/only scheduled run. */
  readonly scheduledAt?: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly archived: boolean;
  /** Estimated execution cost (see `estimateExecutionCost`). */
  readonly costEstimate: number;
}

/**
 * The run history of a single job — the dedupe/citation key of the job layer.
 */
export interface JobHistory {
  readonly jobId: string;
  readonly executions: readonly JobExecution[];
}

/**
 * A stable reference to a job — the lightweight handle used to address a job
 * without carrying its full state (e.g. `runManual` accepts one).
 */
export interface JobReference {
  readonly jobId: string;
  /** The trigger that launched the job, when known. */
  readonly trigger?: JobTrigger;
}

/**
 * Runtime context handed to a job handler at execution time.
 *
 * Carries the current job (in its `running` state), the 1-based attempt
 * number, the executor's cancellation signal (a cooperative handler may stop
 * early), and the injected current time — so handlers stay deterministic.
 */
export interface JobExecutionContext {
  /** The job being executed (status `"running"`). */
  readonly job: Job;
  /** 1-based attempt number within the job's run. */
  readonly attempt: number;
  /** Abort signal observed by the executor; handlers may honor it. */
  readonly signal?: AbortSignal;
  /** ISO-8601 UTC timestamp of the run start (injected, deterministic). */
  readonly now: string;
}

/**
 * Deterministic 32-bit FNV-1a hash of `value`, rendered as lowercase hex.
 * Used to derive stable job/execution ids from a job's own contents, so
 * `createJob`/`createExecution` stay pure and deterministic.
 */
export function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Deterministic job id derived from the job's own contents. */
function jobIdFor(
  name: string,
  trigger: JobTrigger,
  priority: JobPriority,
  createdAt: string,
  scheduledAt: string | undefined,
): string {
  return `job-${hashString(`${name}:${trigger}:${priority}:${createdAt}:${scheduledAt ?? ""}`)}`;
}

/** Options accepted by {@link createJob}. */
export interface CreateJobInput {
  /** Explicit id; when omitted, one is derived deterministically. */
  readonly id?: string;
  readonly name: string;
  readonly status?: JobStatus;
  readonly priority?: JobPriority;
  readonly trigger?: JobTrigger;
  readonly schedule?: JobSchedule;
  /** Attempt budget; defaults to 1 (no retries). */
  readonly maxAttempts?: number;
  /** Started-run count; defaults to 0. */
  readonly attempts?: number;
  /** ISO-8601 UTC timestamp of the job's creation. */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the next/only scheduled run. */
  readonly scheduledAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly archived?: boolean;
  readonly error?: JobError;
  readonly result?: JobResult;
  readonly metadata?: Partial<JobMetadata>;
  readonly executions?: readonly JobExecution[];
}

/**
 * Build a new immutable job.
 *
 * - `id` defaults to a deterministic hash of name + trigger + priority +
 *   createdAt + scheduledAt. Derived ids are stable but not guaranteed
 *   unique across jobs with identical inputs; callers that need uniqueness
 *   should pass an explicit `id`.
 * - `status` defaults to `"pending"`, `priority` to `"normal"`, `trigger` to
 *   `"manual"`, `maxAttempts` to 1, `archived` to false, and `metadata.tags`
 *   to `[]`.
 * - A recurring schedule without `startsAt` is defaulted to `createdAt`.
 * - `metadata` is merged over defaults; `tags` and `executions` are copied
 *   as new arrays. The returned object is new and detached from all inputs.
 */
export function createJob(input: CreateJobInput): Job {
  let schedule = input.schedule;
  if (schedule?.everyMs !== undefined && schedule.startsAt === undefined) {
    schedule = { ...schedule, startsAt: input.createdAt };
  }

  const metadata: JobMetadata = {
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
      jobIdFor(input.name, input.trigger ?? DEFAULT_JOB_TRIGGER, input.priority ?? DEFAULT_JOB_PRIORITY, input.createdAt, input.scheduledAt),
    name: input.name,
    status: input.status ?? DEFAULT_JOB_STATUS,
    priority: input.priority ?? DEFAULT_JOB_PRIORITY,
    trigger: input.trigger ?? DEFAULT_JOB_TRIGGER,
    ...(schedule !== undefined ? { schedule } : {}),
    attempts: input.attempts ?? 0,
    maxAttempts: input.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS,
    createdAt: input.createdAt,
    ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    archived: input.archived ?? DEFAULT_JOB_ARCHIVED,
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
  };
}

/** Options accepted by {@link createExecution}. */
export interface CreateExecutionInput {
  /** Explicit id; when omitted, one is derived deterministically. */
  readonly id?: string;
  readonly jobId: string;
  /** 1-based attempt number within the job's run. */
  readonly attempt: number;
  readonly status: JobStatus;
  /** ISO-8601 UTC timestamp of the attempt's start. */
  readonly startedAt: string;
  /** ISO-8601 UTC timestamp of the attempt's settlement, when settled. */
  readonly finishedAt?: string;
  readonly error?: JobError;
  readonly result?: JobResult;
  /** Wall-clock duration of the attempt in milliseconds, when settled. */
  readonly durationMs?: number;
}

/**
 * Build a new immutable execution record.
 *
 * `id` defaults to a deterministic hash of jobId + attempt + startedAt +
 * status. `error`/`result` are copied as new records; the returned object is
 * new and detached from all inputs.
 */
export function createExecution(input: CreateExecutionInput): JobExecution {
  return {
    id:
      input.id ??
      `exec-${hashString(`${input.jobId}:${input.attempt}:${input.startedAt}:${input.status}`)}`,
    jobId: input.jobId,
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
 * A partial patch applied by {@link touchJob} (and the repository's `update`).
 *
 * Keys present in the patch are applied; missing keys are preserved. A `null`
 * value clears the corresponding optional field.
 */
export type JobPatch = Partial<{
  name: string;
  status: JobStatus;
  priority: JobPriority;
  trigger: JobTrigger;
  schedule: JobSchedule | null;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  archived: boolean;
  error: JobError | null;
  result: JobResult | null;
  tags: readonly string[];
  timeoutMs: number | null;
  retryDelayMs: number | null;
  costUnits: number | null;
  executions: readonly JobExecution[];
}>;

/**
 * Return the successor job with the patch applied.
 *
 * Missing patch keys are preserved; `tags` and `executions` are copied; a
 * `null` value clears an optional field. Deterministic; the input is never
 * mutated.
 */
export function touchJob(job: Job, patch: JobPatch): Job {
  const metadata: JobMetadata = {
    tags: patch.tags !== undefined ? [...patch.tags] : [...job.metadata.tags],
    ...(patch.timeoutMs !== undefined
      ? patch.timeoutMs !== null
        ? { timeoutMs: patch.timeoutMs }
        : {}
      : job.metadata.timeoutMs !== undefined
        ? { timeoutMs: job.metadata.timeoutMs }
        : {}),
    ...(patch.retryDelayMs !== undefined
      ? patch.retryDelayMs !== null
        ? { retryDelayMs: patch.retryDelayMs }
        : {}
      : job.metadata.retryDelayMs !== undefined
        ? { retryDelayMs: job.metadata.retryDelayMs }
        : {}),
    ...(patch.costUnits !== undefined
      ? patch.costUnits !== null
        ? { costUnits: patch.costUnits }
        : {}
      : job.metadata.costUnits !== undefined
        ? { costUnits: job.metadata.costUnits }
        : {}),
  };

  return {
    id: job.id,
    name: patch.name ?? job.name,
    status: patch.status ?? job.status,
    priority: patch.priority ?? job.priority,
    trigger: patch.trigger ?? job.trigger,
    ...(patch.schedule !== undefined
      ? patch.schedule !== null
        ? { schedule: cloneSchedule(patch.schedule) }
        : {}
      : job.schedule !== undefined
        ? { schedule: cloneSchedule(job.schedule) }
        : {}),
    attempts: patch.attempts ?? job.attempts,
    maxAttempts: patch.maxAttempts ?? job.maxAttempts,
    createdAt: patch.createdAt ?? job.createdAt,
    ...(patch.scheduledAt !== undefined
      ? patch.scheduledAt !== null
        ? { scheduledAt: patch.scheduledAt }
        : {}
      : job.scheduledAt !== undefined
        ? { scheduledAt: job.scheduledAt }
        : {}),
    ...(patch.startedAt !== undefined
      ? patch.startedAt !== null
        ? { startedAt: patch.startedAt }
        : {}
      : job.startedAt !== undefined
        ? { startedAt: job.startedAt }
        : {}),
    ...(patch.completedAt !== undefined
      ? patch.completedAt !== null
        ? { completedAt: patch.completedAt }
        : {}
      : job.completedAt !== undefined
        ? { completedAt: job.completedAt }
        : {}),
    archived: patch.archived ?? job.archived,
    ...(patch.error !== undefined
      ? patch.error !== null
        ? { error: { ...patch.error } }
        : {}
      : job.error !== undefined
        ? { error: { ...job.error } }
        : {}),
    ...(patch.result !== undefined
      ? patch.result !== null
        ? { result: cloneResult(patch.result) }
        : {}
      : job.result !== undefined
        ? { result: cloneResult(job.result) }
        : {}),
    metadata,
    executions: patch.executions !== undefined ? [...patch.executions] : [...job.executions],
  };
}

/** Detached copy of a schedule. */
function cloneSchedule(schedule: JobSchedule): JobSchedule {
  return {
    ...(schedule.at !== undefined ? { at: schedule.at } : {}),
    ...(schedule.everyMs !== undefined ? { everyMs: schedule.everyMs } : {}),
    ...(schedule.startsAt !== undefined ? { startsAt: schedule.startsAt } : {}),
  };
}

/** Detached copy of a job result. */
function cloneResult(result: JobResult): JobResult {
  return {
    success: result.success,
    ...(result.output !== undefined ? { output: result.output } : {}),
    ...(result.message !== undefined ? { message: result.message } : {}),
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
  };
}

/**
 * Deep-freeze a job in place and return it.
 *
 * Freezes the job, its metadata (and `tags`), its schedule, its error/result
 * records, the executions array, and every execution (and their nested
 * error/result records). Idempotent: freezing an already frozen job is a
 * no-op.
 */
export function freezeJob(job: Job): Job {
  Object.freeze(job.metadata.tags);
  Object.freeze(job.metadata);
  if (job.schedule !== undefined) Object.freeze(job.schedule);
  if (job.error !== undefined) Object.freeze(job.error);
  if (job.result !== undefined) Object.freeze(job.result);
  for (const execution of job.executions) {
    if (execution.error !== undefined) Object.freeze(execution.error);
    if (execution.result !== undefined) Object.freeze(execution.result);
    Object.freeze(execution);
  }
  Object.freeze(job.executions);
  Object.freeze(job);
  return job;
}

/**
 * Return a deep, detached copy of a job.
 *
 * Every object is new — the job, its metadata (and `tags`), its schedule,
 * its error/result records, the executions array, and each execution (and
 * their nested records) — so mutating the clone's own structure can never
 * affect the source and vice versa. Nested values inside a result's
 * `output` are shared by reference. The clone is not frozen (call
 * `freezeJob` to freeze it). Values, including optional fields, are
 * preserved exactly.
 */
export function cloneJob(job: Job): Job {
  return touchJob(job, {
    executions: job.executions.map((execution) =>
      createExecution({
        id: execution.id,
        jobId: execution.jobId,
        attempt: execution.attempt,
        status: execution.status,
        startedAt: execution.startedAt,
        ...(execution.finishedAt !== undefined ? { finishedAt: execution.finishedAt } : {}),
        ...(execution.error !== undefined ? { error: { ...execution.error } } : {}),
        ...(execution.result !== undefined ? { result: cloneResult(execution.result) } : {}),
        ...(execution.durationMs !== undefined ? { durationMs: execution.durationMs } : {}),
      }),
    ),
  });
}

/**
 * Whether a one-time schedule has a single occurrence.
 */
export function isOneTimeSchedule(schedule: JobSchedule): boolean {
  return schedule.at !== undefined;
}

/**
 * Whether a schedule repeats on an interval.
 */
export function isRecurringSchedule(schedule: JobSchedule): boolean {
  return schedule.everyMs !== undefined && schedule.everyMs > 0;
}

/**
 * The next occurrence of `schedule` strictly after `after` (ISO-8601 UTC).
 *
 * - One-time schedules return their single `at` (the caller decides whether
 *   it is still in the future).
 * - Recurring schedules return the smallest `startsAt + k × everyMs` that is
 *   strictly greater than `after`; a time before `startsAt` yields
 *   `startsAt`. Deterministic and pure.
 */
export function nextOccurrence(schedule: JobSchedule, after: string): string | undefined {
  if (schedule.at !== undefined) return schedule.at;
  if (!isRecurringSchedule(schedule) || schedule.startsAt === undefined) return undefined;

  const startsAtMs = Date.parse(schedule.startsAt);
  const everyMs = schedule.everyMs as number;
  const afterMs = Date.parse(after);

  if (afterMs < startsAtMs) return schedule.startsAt;

  const periods = Math.floor((afterMs - startsAtMs) / everyMs) + 1;
  return new Date(startsAtMs + periods * everyMs).toISOString();
}

/**
 * Whether a job is due to run at `now`.
 *
 * A pending, non-archived job is due when:
 * - it has no schedule (manual/startup/shutdown jobs are runnable whenever
 *   they are pending), or
 * - its `scheduledAt` is defined and at or before `now`.
 *
 * Deterministic — `now` is supplied by the caller.
 */
export function isDue(job: Job, now: string): boolean {
  if (job.status !== "pending" || job.archived) return false;
  if (job.schedule === undefined) return true;
  if (job.scheduledAt === undefined) return false;
  return Date.parse(job.scheduledAt) <= Date.parse(now);
}

/**
 * Whether a job is runnable at `now` (see {@link isDue}).
 *
 * `isJobRunnable` is the schedulability predicate used by the repository,
 * the scheduler, and the runner; identical to `isDue`.
 */
export function isJobRunnable(job: Job, now: string): boolean {
  return isDue(job, now);
}

/**
 * Estimate the execution cost of a job: its explicit `costUnits` when set,
 * else the priority base cost. Deterministic and pure.
 */
export function estimateExecutionCost(job: Job): number {
  return job.metadata.costUnits ?? PRIORITY_COST[job.priority];
}

/**
 * Build a lightweight summary projection of a job (see `JobSummary`).
 */
export function createJobSummary(job: Job): JobSummary {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    priority: job.priority,
    trigger: job.trigger,
    createdAt: job.createdAt,
    ...(job.scheduledAt !== undefined ? { scheduledAt: job.scheduledAt } : {}),
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    archived: job.archived,
    costEstimate: estimateExecutionCost(job),
  };
}

/**
 * Build the run history of a job (see `JobHistory`). Detached — the returned
 * executions array is new.
 */
export function createJobHistory(job: Job): JobHistory {
  return { jobId: job.id, executions: [...job.executions] };
}

/**
 * Build a stable reference to a job (see `JobReference`).
 */
export function createJobReference(job: Job): JobReference {
  return { jobId: job.id, trigger: job.trigger };
}
