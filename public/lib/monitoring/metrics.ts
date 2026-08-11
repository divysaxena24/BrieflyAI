/**
 * Observability & Monitoring — metrics engine (Phase 6C STEP 3).
 *
 * Immutable, deterministic metric collection across every engine domain:
 * API, workers, jobs, workflows, actions, digest, memory, conversation,
 * database, persistence, tool execution, planner, context builder, LLM and
 * queues.
 *
 * A `MetricCollector` is a successor-based store: `record()` returns a new
 * collector carrying the sample; the receiver is never mutated. Aggregation
 * (series, statistics, summaries, reports) is a pure projection.
 *
 * All timestamps are caller-supplied. No wall clock is read here.
 */

import { hashString } from "@/lib/hash";

/** The engine domain a metric belongs to. */
export type MetricDomain =
  | "api"
  | "workers"
  | "jobs"
  | "workflows"
  | "actions"
  | "digest"
  | "memory"
  | "conversation"
  | "database"
  | "persistence"
  | "tool"
  | "planner"
  | "context"
  | "llm"
  | "queue"
  | "events"
  | "notifications";

/** Every metric domain in a stable canonical order. */
export const METRIC_DOMAINS: readonly MetricDomain[] = Object.freeze([
  "api",
  "workers",
  "jobs",
  "workflows",
  "actions",
  "digest",
  "memory",
  "conversation",
  "database",
  "persistence",
  "tool",
  "planner",
  "context",
  "llm",
  "queue",
  "events",
  "notifications",
]);

/** The kind of a metric sample. */
export type MetricKind = "counter" | "gauge" | "latency" | "rate";

/** A single immutable metric sample. */
export interface MetricSample {
  /** Stable id: `metric-<hash(domain:name:timestamp:value)>`. */
  readonly id: string;
  readonly domain: MetricDomain;
  /** Metric name, e.g. "tasks.completed". */
  readonly name: string;
  readonly kind: MetricKind;
  /** The measured value. */
  readonly value: number;
  /** Optional entity id the sample is about (worker, job, …). */
  readonly entityId?: string;
  /** ISO-8601 UTC timestamp (caller-supplied). */
  readonly timestamp: string;
  /** Optional labels. */
  readonly labels?: Readonly<Record<string, string>>;
}

/** A time-ordered series of samples for one (domain, name). */
export interface MetricSeries {
  readonly domain: MetricDomain;
  readonly name: string;
  readonly samples: readonly MetricSample[];
  readonly count: number;
  readonly total: number;
  readonly min?: number;
  readonly max?: number;
  readonly average?: number;
}

/** Aggregate statistics over a set of samples. */
export interface MetricStatistics {
  readonly count: number;
  readonly sum: number;
  readonly min?: number;
  readonly max?: number;
  readonly average?: number;
  /** Samples whose value equals the minimum (tie-break deterministically). */
  readonly p50?: number;
  readonly p95?: number;
  readonly p99?: number;
}

/** Compact summary of one metric. */
export interface MetricSummary {
  readonly domain: MetricDomain;
  readonly name: string;
  readonly count: number;
  readonly last?: number;
  readonly average?: number;
  readonly firstAt?: string;
  readonly lastAt?: string;
}

/** Point-in-time snapshot of a collector. */
export interface MetricSnapshot {
  readonly at: string;
  readonly samples: readonly MetricSample[];
  readonly statistics: MetricStatistics;
  readonly byDomain: Readonly<Record<MetricDomain, MetricStatistics>>;
}

/** A named, reusable metric definition. */
export interface MetricDefinition {
  readonly domain: MetricDomain;
  readonly name: string;
  readonly kind: MetricKind;
  readonly description?: string;
}

/** A named metric with a live value. */
export interface MetricGauge {
  readonly domain: MetricDomain;
  readonly name: string;
  readonly value: number;
  readonly updatedAt: string;
}

/** A full report over a set of samples. */
export interface MetricReport {
  readonly at: string;
  readonly summaries: readonly MetricSummary[];
  readonly statistics: MetricStatistics;
  readonly byDomain: Readonly<Record<MetricDomain, MetricStatistics>>;
}

/** Input accepted by {@link createMetricSample}. */
export interface CreateMetricSampleInput {
  readonly domain: MetricDomain;
  readonly name: string;
  readonly kind: MetricKind;
  readonly value: number;
  readonly entityId?: string;
  readonly timestamp: string;
  readonly labels?: Readonly<Record<string, string>>;
}

/** Deterministic id for a metric sample. */
export function metricSampleIdFor(input: {
  readonly domain: MetricDomain;
  readonly name: string;
  readonly timestamp: string;
  readonly value: number;
}): string {
  return `metric-${hashString(
    `${input.domain}:${input.name}:${input.timestamp}:${input.value}`,
  )}`;
}

/** Build a new immutable metric sample. */
export function createMetricSample(input: CreateMetricSampleInput): MetricSample {
  return Object.freeze({
    id: metricSampleIdFor({
      domain: input.domain,
      name: input.name,
      timestamp: input.timestamp,
      value: input.value,
    }),
    domain: input.domain,
    name: input.name,
    kind: input.kind,
    value: input.value,
    ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
    timestamp: input.timestamp,
    ...(input.labels !== undefined ? { labels: Object.freeze({ ...input.labels }) } : {}),
  });
}

/** Return a deep, detached copy of a sample (never frozen). */
export function cloneMetricSample(sample: MetricSample): MetricSample {
  return {
    id: sample.id,
    domain: sample.domain,
    name: sample.name,
    kind: sample.kind,
    value: sample.value,
    ...(sample.entityId !== undefined ? { entityId: sample.entityId } : {}),
    timestamp: sample.timestamp,
    ...(sample.labels !== undefined ? { labels: { ...sample.labels } } : {}),
  };
}

/** Deep-freeze a sample in place and return it (idempotent). */
export function freezeMetricSample(sample: MetricSample): MetricSample {
  if (sample.labels !== undefined) Object.freeze(sample.labels);
  return Object.freeze(sample);
}

/** Stable hash of a sample's identity. */
export function hashMetricSample(sample: MetricSample): string {
  return hashString(`${sample.id}:${sample.domain}:${sample.name}`);
}

/** Options accepted by the {@link MetricCollector} constructor. */
export interface MetricCollectorOptions {
  readonly samples?: readonly MetricSample[];
  readonly gauges?: readonly MetricGauge[];
  /** Keep at most this many samples (oldest dropped). */
  readonly maxSamples?: number;
}

/** Aggregation helpers. */
function aggregate(values: readonly number[]): MetricStatistics {
  if (values.length === 0) {
    return Object.freeze({ count: 0, sum: 0 });
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((total, value) => total + value, 0);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const average = sum / values.length;
  const percentile = (p: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    const at = sorted[index];
    return at ?? 0;
  };
  return Object.freeze({
    count: values.length,
    sum,
    min,
    max,
    average,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  });
}

/** Aggregate statistics over a set of samples. */
export function metricStatistics(samples: readonly MetricSample[]): MetricStatistics {
  return aggregate(samples.map((sample) => sample.value));
}

/** Group statistics per domain (stable domain order). */
export function metricStatisticsByDomain(
  samples: readonly MetricSample[],
): Readonly<Record<MetricDomain, MetricStatistics>> {
  const result: Record<MetricDomain, MetricStatistics> = {
    api: aggregate([]),
    workers: aggregate([]),
    jobs: aggregate([]),
    workflows: aggregate([]),
    actions: aggregate([]),
    digest: aggregate([]),
    memory: aggregate([]),
    conversation: aggregate([]),
    database: aggregate([]),
    persistence: aggregate([]),
    tool: aggregate([]),
    planner: aggregate([]),
    context: aggregate([]),
    llm: aggregate([]),
    queue: aggregate([]),
    events: aggregate([]),
    notifications: aggregate([]),
  };
  for (const domain of METRIC_DOMAINS) {
    result[domain] = aggregate(
      samples.filter((sample) => sample.domain === domain).map((sample) => sample.value),
    );
  }
  return result;
}

/** Build a time-ordered series for one (domain, name). */
export function metricSeries(
  samples: readonly MetricSample[],
  domain: MetricDomain,
  name: string,
): MetricSeries {
  const matching = samples
    .filter((sample) => sample.domain === domain && sample.name === name)
    .map(cloneMetricSample);
  const stats = metricStatistics(matching);
  return Object.freeze({
    domain,
    name,
    samples: Object.freeze(matching),
    count: stats.count,
    total: stats.sum,
    ...(stats.min !== undefined ? { min: stats.min } : {}),
    ...(stats.max !== undefined ? { max: stats.max } : {}),
    ...(stats.average !== undefined ? { average: stats.average } : {}),
  });
}

/** Build compact summaries for every observed (domain, name) pair. */
export function metricSummaries(samples: readonly MetricSample[]): readonly MetricSummary[] {
  const keys = new Map<string, { domain: MetricDomain; name: string }>();
  for (const sample of samples) {
    keys.set(`${sample.domain}:${sample.name}`, { domain: sample.domain, name: sample.name });
  }
  return Object.freeze(
    [...keys.values()]
      .sort((a, b) => (a.domain + a.name < b.domain + b.name ? -1 : 1))
      .map(({ domain, name }) => {
        const matching = samples.filter(
          (sample) => sample.domain === domain && sample.name === name,
        );
        const stats = metricStatistics(matching);
        const last = matching[matching.length - 1];
        return Object.freeze({
          domain,
          name,
          count: stats.count,
          ...(last !== undefined ? { last: last.value } : {}),
          ...(stats.average !== undefined ? { average: stats.average } : {}),
          ...(matching[0] !== undefined ? { firstAt: matching[0].timestamp } : {}),
          ...(last !== undefined ? { lastAt: last.timestamp } : {}),
        });
      }),
  );
}

/**
 * An immutable metric collector. `record()` returns a successor collector
 * carrying the sample; the receiver is never mutated. Gauges are upserted
 * by (domain, name) via successor construction.
 */
export class MetricCollector {
  readonly samples: readonly MetricSample[];
  readonly gauges: readonly MetricGauge[];

  private readonly maxSamples: number | undefined;

  constructor(options: MetricCollectorOptions = {}) {
    this.samples = Object.freeze([...(options.samples ?? [])].map(cloneMetricSample));
    this.gauges = Object.freeze(
      [...(options.gauges ?? [])].map((gauge) => Object.freeze({ ...gauge })),
    );
    this.maxSamples = options.maxSamples;
  }

  /** Build a successor collector from partial state. */
  private next(partial: { samples: readonly MetricSample[]; gauges: readonly MetricGauge[] }): MetricCollector {
    return new MetricCollector({
      samples: partial.samples,
      gauges: partial.gauges,
      maxSamples: this.maxSamples,
    });
  }

  /** The number of retained samples. */
  count(): number {
    return this.samples.length;
  }

  /** Detached copies of every retained sample, oldest first. */
  list(): MetricSample[] {
    return this.samples.map(cloneMetricSample);
  }

  /** Samples for `domain` and `name` (all when `name` omitted). */
  find(domain: MetricDomain, name?: string): MetricSample[] {
    return this.samples
      .filter((sample) => sample.domain === domain)
      .filter((sample) => name === undefined || sample.name === name)
      .map(cloneMetricSample);
  }

  /** The latest gauge value for `(domain, name)`, or `undefined`. */
  gauge(domain: MetricDomain, name: string): MetricGauge | undefined {
    let latest: MetricGauge | undefined;
    for (const gauge of this.gauges) {
      if (gauge.domain === domain && gauge.name === name) {
        latest = gauge;
      }
    }
    return latest === undefined ? undefined : { ...latest };
  }

  /** Record a sample; returns the successor collector. */
  record(input: CreateMetricSampleInput): { collector: MetricCollector; sample: MetricSample } {
    const sample = createMetricSample(input);
    let samples = [...this.samples, sample];
    if (this.maxSamples !== undefined && samples.length > this.maxSamples) {
      samples = samples.slice(samples.length - this.maxSamples);
    }
    return { collector: this.next({ samples, gauges: this.gauges }), sample };
  }

  /** Record a counter increment; returns the successor collector. */
  increment(
    domain: MetricDomain,
    name: string,
    timestamp: string,
    by = 1,
    entityId?: string,
  ): { collector: MetricCollector; sample: MetricSample } {
    return this.record({
      domain,
      name,
      kind: "counter",
      value: by,
      timestamp,
      ...(entityId !== undefined ? { entityId } : {}),
    });
  }

  /** Record a latency sample; returns the successor collector. */
  latency(
    domain: MetricDomain,
    name: string,
    durationMs: number,
    timestamp: string,
    entityId?: string,
  ): { collector: MetricCollector; sample: MetricSample } {
    return this.record({
      domain,
      name,
      kind: "latency",
      value: durationMs,
      timestamp,
      ...(entityId !== undefined ? { entityId } : {}),
    });
  }

  /** Set (or update) a gauge; returns the successor collector. */
  setGauge(
    domain: MetricDomain,
    name: string,
    value: number,
    timestamp: string,
  ): MetricCollector {
    const gauges = this.gauges
      .filter((gauge) => !(gauge.domain === domain && gauge.name === name))
      .concat([Object.freeze({ domain, name, value, updatedAt: timestamp })]);
    return this.next({ samples: this.samples, gauges });
  }

  /** Aggregate statistics over all retained samples. */
  statistics(): MetricStatistics {
    return metricStatistics(this.samples);
  }

  /** Statistics grouped per domain. */
  statisticsByDomain(): Readonly<Record<MetricDomain, MetricStatistics>> {
    return metricStatisticsByDomain(this.samples);
  }

  /** Compact summaries for every observed (domain, name) pair. */
  summaries(): readonly MetricSummary[] {
    return metricSummaries(this.samples);
  }

  /** A full report at `at`. */
  report(at: string): MetricReport {
    return Object.freeze({
      at,
      summaries: this.summaries(),
      statistics: this.statistics(),
      byDomain: this.statisticsByDomain(),
    });
  }

  /** Point-in-time snapshot at `at`. */
  snapshot(at: string): MetricSnapshot {
    return Object.freeze({
      at,
      samples: this.list(),
      statistics: this.statistics(),
      byDomain: this.statisticsByDomain(),
    });
  }

  /** Detached copies of every gauge. */
  listGauges(): MetricGauge[] {
    return this.gauges.map((gauge) => ({ ...gauge }));
  }
}

/** Input accepted by {@link MetricRegistry.register}. */
export interface RegisterMetricInput {
  readonly domain: MetricDomain;
  readonly name: string;
  readonly kind: MetricKind;
  readonly description?: string;
}

/**
 * An immutable registry of metric definitions. Successor-based: `register`
 * returns a new registry; duplicates throw.
 */
export class MetricRegistry {
  readonly definitions: readonly MetricDefinition[];

  constructor(definitions: readonly MetricDefinition[] = []) {
    const seen = new Set<string>();
    for (const definition of definitions) {
      const key = `${definition.domain}:${definition.name}`;
      if (seen.has(key)) {
        throw new Error(`Metric registry already contains "${key}"`);
      }
      seen.add(key);
    }
    this.definitions = Object.freeze(definitions.map((d) => Object.freeze({ ...d })));
  }

  /** Return a new registry with `definition` registered. */
  register(input: RegisterMetricInput): MetricRegistry {
    if (this.has(input.domain, input.name)) {
      throw new Error(
        `Metric registry already contains "${input.domain}:${input.name}"`,
      );
    }
    const definition: MetricDefinition = Object.freeze({
      domain: input.domain,
      name: input.name,
      kind: input.kind,
      ...(input.description !== undefined ? { description: input.description } : {}),
    });
    return new MetricRegistry([...this.definitions, definition]);
  }

  /** Whether `(domain, name)` is defined. */
  has(domain: MetricDomain, name: string): boolean {
    return this.definitions.some(
      (definition) => definition.domain === domain && definition.name === name,
    );
  }

  /** The definition for `(domain, name)`, or `undefined`. */
  get(domain: MetricDomain, name: string): MetricDefinition | undefined {
    return this.definitions.find(
      (definition) => definition.domain === domain && definition.name === name,
    );
  }

  /** Snapshot of every definition in registration order. */
  list(): readonly MetricDefinition[] {
    return this.definitions.map((definition) => ({ ...definition }));
  }

  /** The number of registered definitions. */
  count(): number {
    return this.definitions.length;
  }
}

/**
 * Aggregates many collectors into one (used for rollups). Pure — returns a
 * new collector; none of the inputs are mutated.
 */
export function aggregateCollectors(collectors: readonly MetricCollector[]): MetricCollector {
  return new MetricCollector({
    samples: collectors.flatMap((collector) => collector.samples),
    gauges: collectors.flatMap((collector) => collector.gauges),
  });
}

/**
 * Combine many reports into one rollup report at `at`. Each input report's
 * summaries are projected into samples so the combined statistics reflect
 * the union of every metric. Pure — no input is mutated.
 */
export function combineReports(at: string, reports: readonly MetricReport[]): MetricReport {
  const projected: MetricSample[] = [];
  for (const report of reports) {
    for (const summary of report.summaries) {
      projected.push(
        createMetricSample({
          domain: summary.domain,
          name: summary.name,
          kind: "gauge",
          value: summary.last ?? 0,
          timestamp: summary.lastAt ?? at,
        }),
      );
    }
  }
  const unique: MetricSample[] = [];
  const seen = new Set<string>();
  for (const sample of projected) {
    const key = `${sample.domain}:${sample.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(sample);
  }
  return Object.freeze({
    at,
    summaries: Object.freeze([]),
    statistics: metricStatistics(unique),
    byDomain: metricStatisticsByDomain(unique),
  });
}
