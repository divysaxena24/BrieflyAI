/**
 * Observability & Monitoring — performance profiler (Phase 6C STEP 5).
 *
 * Immutable, deterministic profiling across every measured stage: execution,
 * queue wait, worker execution, planner, tool, workflow, database, API,
 * memory retrieval and RAG retrieval.
 *
 * A `ProfileCollector` is successor-based; `record()` returns a new
 * collector. Durations are measured through an injected millisecond clock —
 * this module never reads the wall clock itself. All timestamps are
 * caller-supplied.
 */

import { hashString } from "@/lib/hash";

/** The stage a profile measures. */
export type ProfileStage =
  | "execution"
  | "queue_wait"
  | "worker_execution"
  | "planner"
  | "tool"
  | "workflow"
  | "database"
  | "api"
  | "memory_retrieval"
  | "rag_retrieval"
  | "digest"
  | "action"
  | "job"
  | "conversation"
  | "context"
  | "llm"
  | "notification";

/** Every profile stage in a stable canonical order. */
export const PROFILE_STAGES: readonly ProfileStage[] = Object.freeze([
  "execution",
  "queue_wait",
  "worker_execution",
  "planner",
  "tool",
  "workflow",
  "database",
  "api",
  "memory_retrieval",
  "rag_retrieval",
  "digest",
  "action",
  "job",
  "conversation",
  "context",
  "llm",
  "notification",
]);

/** A single immutable profiling sample. */
export interface ProfileSample {
  /** Stable id: `profile-<hash(stage:name:startedAt:durationMs)>`. */
  readonly id: string;
  readonly stage: ProfileStage;
  /** Optional scope label (e.g. a worker/request id). */
  readonly name: string;
  /** Wall-clock duration in milliseconds (measured via injected clock). */
  readonly durationMs: number;
  /** ISO-8601 UTC start timestamp (caller-supplied). */
  readonly startedAt: string;
  readonly entityId?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** A time-ordered series for one stage. */
export interface ProfileSeries {
  readonly stage: ProfileStage;
  readonly samples: readonly ProfileSample[];
  readonly count: number;
  readonly totalMs: number;
  readonly minMs?: number;
  readonly maxMs?: number;
  readonly averageMs?: number;
}

/** Aggregate statistics over a set of samples. */
export interface ProfileStatistics {
  readonly count: number;
  readonly totalMs: number;
  readonly minMs?: number;
  readonly maxMs?: number;
  readonly averageMs?: number;
  readonly p50?: number;
  readonly p95?: number;
  readonly p99?: number;
}

/** Compact summary of one stage. */
export interface ProfileSummary {
  readonly stage: ProfileStage;
  readonly count: number;
  readonly averageMs?: number;
  readonly maxMs?: number;
  readonly totalMs: number;
}

/** Point-in-time snapshot of a profiler. */
export interface ProfileSnapshot {
  readonly at: string;
  readonly samples: readonly ProfileSample[];
  readonly statistics: ProfileStatistics;
  readonly byStage: Readonly<Record<ProfileStage, ProfileStatistics>>;
}

/** A full performance report at a point in time. */
export interface PerformanceReport {
  readonly at: string;
  readonly summaries: readonly ProfileSummary[];
  readonly statistics: ProfileStatistics;
  readonly byStage: Readonly<Record<ProfileStage, ProfileStatistics>>;
}

/** Input accepted by {@link createProfileSample}. */
export interface CreateProfileSampleInput {
  readonly stage: ProfileStage;
  readonly name: string;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly entityId?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** Deterministic id for a profile sample. */
export function profileSampleIdFor(input: {
  readonly stage: ProfileStage;
  readonly name: string;
  readonly startedAt: string;
  readonly durationMs: number;
}): string {
  return `profile-${hashString(
    `${input.stage}:${input.name}:${input.startedAt}:${input.durationMs}`,
  )}`;
}

/** Build a new immutable profile sample. */
export function createProfileSample(input: CreateProfileSampleInput): ProfileSample {
  return Object.freeze({
    id: profileSampleIdFor({
      stage: input.stage,
      name: input.name,
      startedAt: input.startedAt,
      durationMs: input.durationMs,
    }),
    stage: input.stage,
    name: input.name,
    durationMs: input.durationMs,
    startedAt: input.startedAt,
    ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
    ...(input.attributes !== undefined
      ? { attributes: Object.freeze({ ...input.attributes }) }
      : {}),
  });
}

/** Return a deep, detached copy of a sample (never frozen). */
export function cloneProfileSample(sample: ProfileSample): ProfileSample {
  return {
    id: sample.id,
    stage: sample.stage,
    name: sample.name,
    durationMs: sample.durationMs,
    startedAt: sample.startedAt,
    ...(sample.entityId !== undefined ? { entityId: sample.entityId } : {}),
    ...(sample.attributes !== undefined ? { attributes: { ...sample.attributes } } : {}),
  };
}

/** Deep-freeze a sample in place and return it (idempotent). */
export function freezeProfileSample(sample: ProfileSample): ProfileSample {
  if (sample.attributes !== undefined) Object.freeze(sample.attributes);
  return Object.freeze(sample);
}

/** Stable hash of a sample's identity. */
export function hashProfileSample(sample: ProfileSample): string {
  return hashString(`${sample.id}:${sample.stage}:${sample.durationMs}`);
}

/** Aggregate statistics over durations. */
function aggregate(durations: readonly number[]): ProfileStatistics {
  if (durations.length === 0) {
    return Object.freeze({ count: 0, totalMs: 0 });
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const totalMs = durations.reduce((total, value) => total + value, 0);
  const minMs = sorted[0];
  const maxMs = sorted[sorted.length - 1];
  const averageMs = totalMs / durations.length;
  const percentile = (p: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    const at = sorted[index];
    return at ?? 0;
  };
  return Object.freeze({
    count: durations.length,
    totalMs,
    minMs,
    maxMs,
    averageMs,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  });
}

/** Aggregate statistics over a set of samples. */
export function profileStatistics(samples: readonly ProfileSample[]): ProfileStatistics {
  return aggregate(samples.map((sample) => sample.durationMs));
}

/** Statistics grouped per stage (stable stage order). */
export function profileStatisticsByStage(
  samples: readonly ProfileSample[],
): Readonly<Record<ProfileStage, ProfileStatistics>> {
  const result: Record<ProfileStage, ProfileStatistics> = {
    execution: aggregate([]),
    queue_wait: aggregate([]),
    worker_execution: aggregate([]),
    planner: aggregate([]),
    tool: aggregate([]),
    workflow: aggregate([]),
    database: aggregate([]),
    api: aggregate([]),
    memory_retrieval: aggregate([]),
    rag_retrieval: aggregate([]),
    digest: aggregate([]),
    action: aggregate([]),
    job: aggregate([]),
    conversation: aggregate([]),
    context: aggregate([]),
    llm: aggregate([]),
    notification: aggregate([]),
  };
  for (const stage of PROFILE_STAGES) {
    result[stage] = aggregate(
      samples.filter((sample) => sample.stage === stage).map((sample) => sample.durationMs),
    );
  }
  return result;
}

/** Build a time-ordered series for one stage. */
export function profileSeries(
  samples: readonly ProfileSample[],
  stage: ProfileStage,
): ProfileSeries {
  const matching = samples.filter((sample) => sample.stage === stage).map(cloneProfileSample);
  const stats = aggregate(matching.map((sample) => sample.durationMs));
  return Object.freeze({
    stage,
    samples: Object.freeze(matching),
    count: stats.count,
    totalMs: stats.totalMs,
    ...(stats.minMs !== undefined ? { minMs: stats.minMs } : {}),
    ...(stats.maxMs !== undefined ? { maxMs: stats.maxMs } : {}),
    ...(stats.averageMs !== undefined ? { averageMs: stats.averageMs } : {}),
  });
}

/** Compact summaries for every observed stage. */
export function profileSummaries(samples: readonly ProfileSample[]): readonly ProfileSummary[] {
  return Object.freeze(
    PROFILE_STAGES.filter((stage) => samples.some((sample) => sample.stage === stage)).map(
      (stage) => {
        const stats = aggregate(
          samples.filter((sample) => sample.stage === stage).map((sample) => sample.durationMs),
        );
        return Object.freeze({
          stage,
          count: stats.count,
          ...(stats.averageMs !== undefined ? { averageMs: stats.averageMs } : {}),
          ...(stats.maxMs !== undefined ? { maxMs: stats.maxMs } : {}),
          totalMs: stats.totalMs,
        });
      },
    ),
  );
}

/** Options accepted by the {@link ProfileCollector} constructor. */
export interface ProfileCollectorOptions {
  readonly samples?: readonly ProfileSample[];
  readonly maxSamples?: number;
}

/**
 * An immutable profile collector. `record()` returns a successor collector;
 * the receiver is never mutated. `measure()` runs `work` between two
 * injected clock reads and records the duration.
 */
export class ProfileCollector {
  readonly samples: readonly ProfileSample[];

  private readonly maxSamples: number | undefined;

  constructor(options: ProfileCollectorOptions = {}) {
    this.samples = Object.freeze([...(options.samples ?? [])].map(cloneProfileSample));
    this.maxSamples = options.maxSamples;
  }

  /** Build a successor collector from partial state. */
  private next(samples: readonly ProfileSample[]): ProfileCollector {
    return new ProfileCollector({ samples, maxSamples: this.maxSamples });
  }

  /** The number of retained samples. */
  count(): number {
    return this.samples.length;
  }

  /** Detached copies of every retained sample, oldest first. */
  list(): ProfileSample[] {
    return this.samples.map(cloneProfileSample);
  }

  /** Samples for `stage`. */
  find(stage: ProfileStage): ProfileSample[] {
    return this.samples.filter((sample) => sample.stage === stage).map(cloneProfileSample);
  }

  /** Record a sample; returns the successor collector. */
  record(input: CreateProfileSampleInput): { collector: ProfileCollector; sample: ProfileSample } {
    const sample = createProfileSample(input);
    let samples = [...this.samples, sample];
    if (this.maxSamples !== undefined && samples.length > this.maxSamples) {
      samples = samples.slice(samples.length - this.maxSamples);
    }
    return { collector: this.next(samples), sample };
  }

  /**
   * Measure `work` using the injected `clockMs` and record the duration.
   * Returns the successor collector, the duration, and the work's result.
   */
  async measure<T>(
    input: {
      readonly stage: ProfileStage;
      readonly name: string;
      readonly startedAt: string;
      readonly clockMs: () => number;
      readonly entityId?: string;
    },
    work: () => Promise<T>,
  ): Promise<{ collector: ProfileCollector; durationMs: number; result: T }> {
    const started = input.clockMs();
    const result = await work();
    const finished = input.clockMs();
    const durationMs = Math.max(0, finished - started);
    const { collector } = this.record({
      stage: input.stage,
      name: input.name,
      durationMs,
      startedAt: input.startedAt,
      ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
    });
    return { collector, durationMs, result };
  }

  /** Aggregate statistics over all retained samples. */
  statistics(): ProfileStatistics {
    return profileStatistics(this.samples);
  }

  /** Statistics grouped per stage. */
  statisticsByStage(): Readonly<Record<ProfileStage, ProfileStatistics>> {
    return profileStatisticsByStage(this.samples);
  }

  /** Compact summaries for every observed stage. */
  summaries(): readonly ProfileSummary[] {
    return profileSummaries(this.samples);
  }

  /** A full performance report at `at`. */
  report(at: string): PerformanceReport {
    return Object.freeze({
      at,
      summaries: this.summaries(),
      statistics: this.statistics(),
      byStage: this.statisticsByStage(),
    });
  }

  /** Point-in-time snapshot at `at`. */
  snapshot(at: string): ProfileSnapshot {
    return Object.freeze({
      at,
      samples: this.list(),
      statistics: this.statistics(),
      byStage: this.statisticsByStage(),
    });
  }
}

/** Build a fresh profile collector. */
export function createProfileCollector(options: ProfileCollectorOptions = {}): ProfileCollector {
  return new ProfileCollector(options);
}
