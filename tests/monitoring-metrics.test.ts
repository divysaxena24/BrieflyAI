import { describe, it, expect } from "vitest";
import {
  METRIC_DOMAINS,
  MetricCollector,
  MetricRegistry,
  aggregateCollectors,
  cloneMetricSample,
  combineReports,
  createMetricSample,
  freezeMetricSample,
  hashMetricSample,
  metricSampleIdFor,
  metricSeries,
  metricStatistics,
  type MetricDomain,
} from "@/lib/monitoring/metrics";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:01:00.000Z";

describe("metricSampleIdFor / createMetricSample", () => {
  it("derives deterministic ids", () => {
    const a = metricSampleIdFor({ domain: "api", name: "requests", timestamp: NOW, value: 1 });
    const b = metricSampleIdFor({ domain: "api", name: "requests", timestamp: NOW, value: 1 });
    const c = metricSampleIdFor({ domain: "api", name: "requests", timestamp: NOW, value: 2 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^metric-[0-9a-f]{8}$/);
  });

  it("deep-freezes samples and labels", () => {
    const sample = createMetricSample({
      domain: "workers",
      name: "tasks.completed",
      kind: "counter",
      value: 3,
      timestamp: NOW,
      labels: { pool: "main" },
    });
    expect(Object.isFrozen(sample)).toBe(true);
    expect(sample.labels && Object.isFrozen(sample.labels)).toBe(true);
  });

  it("normalizes optional fields", () => {
    const sample = createMetricSample({
      domain: "jobs",
      name: "runs",
      kind: "counter",
      value: 1,
      timestamp: NOW,
    });
    expect(sample.entityId).toBeUndefined();
    expect(sample.labels).toBeUndefined();
  });
});

describe("clone / freeze / hash", () => {
  it("cloneMetricSample returns a detached mutable copy", () => {
    const sample = createMetricSample({
      domain: "api",
      name: "requests",
      kind: "counter",
      value: 1,
      timestamp: NOW,
    });
    const clone = cloneMetricSample(sample);
    expect(clone).toEqual(sample);
    expect(clone).not.toBe(sample);
    expect(Object.isFrozen(clone)).toBe(false);
  });

  it("freezeMetricSample is idempotent", () => {
    const sample = createMetricSample({
      domain: "api",
      name: "requests",
      kind: "counter",
      value: 1,
      timestamp: NOW,
    });
    expect(freezeMetricSample(freezeMetricSample(sample))).toBe(freezeMetricSample(sample));
  });

  it("hashMetricSample is stable and sensitive", () => {
    const a = createMetricSample({ domain: "api", name: "requests", kind: "counter", value: 1, timestamp: NOW });
    const b = createMetricSample({ domain: "api", name: "requests", kind: "counter", value: 1, timestamp: NOW });
    const c = createMetricSample({ domain: "api", name: "requests", kind: "counter", value: 9, timestamp: NOW });
    expect(hashMetricSample(a)).toBe(hashMetricSample(b));
    expect(hashMetricSample(a)).not.toBe(hashMetricSample(c));
  });
});

describe("MetricCollector.record", () => {
  it("returns a successor collector and never mutates the receiver", () => {
    const collector = new MetricCollector();
    const { collector: next, sample } = collector.increment("api", "requests", NOW);
    expect(sample.value).toBe(1);
    expect(collector.count()).toBe(0);
    expect(next.count()).toBe(1);
  });

  it("bounds retained samples with maxSamples", () => {
    const collector = new MetricCollector({ maxSamples: 2 });
    let current = collector;
    for (let index = 0; index < 3; index += 1) {
      const { collector: next } = current.increment("api", "requests", NOW);
      current = next;
    }
    expect(current.count()).toBe(2);
  });

  it("increment and latency record typed samples", () => {
    let collector = new MetricCollector();
    const { collector: a, sample: inc } = collector.increment("jobs", "runs", NOW, 1, "job-1");
    collector = a;
    const { collector: b, sample: lat } = collector.latency("api", "latency", 42, NOW, "req-1");
    expect(inc.kind).toBe("counter");
    expect(inc.entityId).toBe("job-1");
    expect(lat.kind).toBe("latency");
    expect(lat.value).toBe(42);
    expect(lat.entityId).toBe("req-1");
    expect(b.count()).toBe(2);
  });

  it("setGauge upserts by (domain, name)", () => {
    let collector = new MetricCollector();
    collector = collector.setGauge("workers", "active", 2, NOW);
    collector = collector.setGauge("workers", "active", 5, LATER);
    expect(collector.listGauges()).toHaveLength(1);
    expect(collector.gauge("workers", "active")?.value).toBe(5);
    collector = collector.setGauge("workers", "idle", 1, LATER);
    expect(collector.listGauges()).toHaveLength(2);
  });
});

describe("aggregation", () => {
  it("metricStatistics aggregates empty samples", () => {
    const stats = metricStatistics([]);
    expect(stats.count).toBe(0);
    expect(stats.sum).toBe(0);
    expect(stats.min).toBeUndefined();
  });

  it("metricStatistics computes min/max/average/percentiles deterministically", () => {
    const collector = new MetricCollector();
    let current = collector;
    for (const value of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      const { collector: next } = current.latency("api", "latency", value, NOW);
      current = next;
    }
    const stats = current.statistics();
    expect(stats.count).toBe(10);
    expect(stats.sum).toBe(550);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(100);
    expect(stats.average).toBe(55);
    expect(stats.p50).toBe(50);
    expect(stats.p95).toBe(100);
    expect(stats.p99).toBe(100);
  });

  it("metricStatisticsByDomain covers every domain", () => {
    const collector = new MetricCollector();
    const { collector: next } = collector.increment("workers", "tasks", NOW);
    const byDomain = next.statisticsByDomain();
    for (const domain of METRIC_DOMAINS) {
      expect(byDomain[domain]).toBeDefined();
    }
    expect(byDomain.workers.count).toBe(1);
    expect(byDomain.api.count).toBe(0);
  });

  it("metricSeries orders samples and computes aggregate", () => {
    const collector = new MetricCollector();
    let current = collector;
    current = current.increment("api", "requests", NOW).collector;
    current = current.increment("api", "requests", LATER).collector;
    current = current.increment("jobs", "runs", NOW).collector;
    const series = metricSeries(current.samples, "api", "requests");
    expect(series.count).toBe(2);
    expect(series.samples.map((sample) => sample.value)).toEqual([1, 1]);
    expect(series.total).toBe(2);
  });

  it("metricSummaries lists observed metrics deterministically", () => {
    const collector = new MetricCollector();
    let current = collector;
    current = current.increment("api", "requests", NOW).collector;
    current = current.increment("jobs", "runs", NOW).collector;
    const summaries = current.summaries();
    expect(summaries.map((summary) => summary.name)).toEqual(["requests", "runs"]);
    expect(summaries[0]?.domain).toBe("api");
    expect(summaries[1]?.domain).toBe("jobs");
  });
});

describe("report / snapshot / find", () => {
  it("builds a deterministic report at `at`", () => {
    const collector = new MetricCollector();
    const { collector: next } = collector.increment("api", "requests", NOW, 3);
    const report = next.report(LATER);
    expect(report.at).toBe(LATER);
    expect(report.statistics.sum).toBe(3);
    expect(report.summaries).toHaveLength(1);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it("snapshot is frozen with samples and statistics", () => {
    const collector = new MetricCollector();
    const { collector: next } = collector.latency("database", "query", 12, NOW);
    const snapshot = next.snapshot(NOW);
    expect(snapshot.at).toBe(NOW);
    expect(snapshot.samples).toHaveLength(1);
    expect(snapshot.statistics.average).toBe(12);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("find filters by domain and optional name", () => {
    const collector = new MetricCollector();
    let current = collector;
    current = current.increment("api", "requests", NOW).collector;
    current = current.increment("api", "latency", NOW).collector;
    current = current.increment("jobs", "runs", NOW).collector;
    expect(current.find("api")).toHaveLength(2);
    expect(current.find("api", "requests")).toHaveLength(1);
    expect(current.find("api", "missing")).toHaveLength(0);
  });
});

describe("MetricRegistry", () => {
  it("registers unique definitions and throws on duplicates", () => {
    const registry = new MetricRegistry();
    const next = registry.register({ domain: "api", name: "requests", kind: "counter" });
    expect(next.count()).toBe(1);
    expect(next.has("api", "requests")).toBe(true);
    expect(() => next.register({ domain: "api", name: "requests", kind: "counter" })).toThrow();
  });

  it("constructor rejects duplicate definitions", () => {
    const a = { domain: "api" as MetricDomain, name: "x", kind: "counter" as const };
    expect(() => new MetricRegistry([a, a])).toThrow();
  });

  it("get returns the definition or undefined", () => {
    const registry = new MetricRegistry([{ domain: "workers", name: "active", kind: "gauge" }]);
    expect(registry.get("workers", "active")?.kind).toBe("gauge");
    expect(registry.get("workers", "missing")).toBeUndefined();
  });

  it("list returns frozen copies in order", () => {
    const registry = new MetricRegistry([
      { domain: "api", name: "a", kind: "counter" },
      { domain: "jobs", name: "b", kind: "counter" },
    ]);
    expect(registry.list().map((d) => d.name)).toEqual(["a", "b"]);
  });
});

describe("aggregateCollectors / combineReports", () => {
  it("aggregateCollectors merges samples without mutating inputs", () => {
    const a = new MetricCollector();
    const b = new MetricCollector();
    const { collector: a2 } = a.increment("api", "requests", NOW, 2);
    const { collector: b2 } = b.increment("jobs", "runs", NOW, 1);
    const merged = aggregateCollectors([a2, b2]);
    expect(merged.count()).toBe(2);
    expect(a2.count()).toBe(1);
    expect(b2.count()).toBe(1);
  });

  it("combineReports rolls up summaries into a unified statistics view", () => {
    const collector = new MetricCollector();
    let current = collector;
    current = current.increment("api", "requests", NOW, 3).collector;
    const report = current.report(NOW);
    const combined = combineReports(LATER, [report, report]);
    expect(combined.at).toBe(LATER);
    expect(combined.statistics.count).toBe(1);
    expect(combined.statistics.sum).toBe(3);
    expect(Object.isFrozen(combined)).toBe(true);
  });
});
