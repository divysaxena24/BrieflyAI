import { describe, it, expect } from "vitest";
import {
  PROFILE_STAGES,
  ProfileCollector,
  cloneProfileSample,
  createProfileCollector,
  createProfileSample,
  freezeProfileSample,
  hashProfileSample,
  profileSampleIdFor,
  profileSeries,
  profileStatistics,
  type ProfileStage,
} from "@/lib/monitoring/profiler";

const NOW = "2026-08-11T09:00:00.000Z";

describe("profileSampleIdFor / createProfileSample", () => {
  it("derives deterministic ids", () => {
    const a = profileSampleIdFor({ stage: "planner", name: "plan", startedAt: NOW, durationMs: 5 });
    const b = profileSampleIdFor({ stage: "planner", name: "plan", startedAt: NOW, durationMs: 5 });
    const c = profileSampleIdFor({ stage: "planner", name: "plan", startedAt: NOW, durationMs: 6 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^profile-[0-9a-f]{8}$/);
  });

  it("deep-freezes samples and attributes", () => {
    const sample = createProfileSample({
      stage: "tool",
      name: "search",
      durationMs: 3,
      startedAt: NOW,
      attributes: { hits: 2 },
    });
    expect(Object.isFrozen(sample)).toBe(true);
    expect(sample.attributes && Object.isFrozen(sample.attributes)).toBe(true);
  });
});

describe("clone / freeze / hash", () => {
  it("cloneProfileSample returns a detached mutable copy", () => {
    const sample = createProfileSample({ stage: "api", name: "req", durationMs: 1, startedAt: NOW });
    const clone = cloneProfileSample(sample);
    expect(clone).toEqual(sample);
    expect(clone).not.toBe(sample);
    expect(Object.isFrozen(clone)).toBe(false);
  });

  it("freezeProfileSample is idempotent", () => {
    const sample = createProfileSample({ stage: "api", name: "req", durationMs: 1, startedAt: NOW });
    expect(freezeProfileSample(freezeProfileSample(sample))).toBe(freezeProfileSample(sample));
  });

  it("hashProfileSample is stable and sensitive", () => {
    const a = createProfileSample({ stage: "api", name: "req", durationMs: 1, startedAt: NOW });
    const b = createProfileSample({ stage: "api", name: "req", durationMs: 1, startedAt: NOW });
    const c = createProfileSample({ stage: "api", name: "req", durationMs: 2, startedAt: NOW });
    expect(hashProfileSample(a)).toBe(hashProfileSample(b));
    expect(hashProfileSample(a)).not.toBe(hashProfileSample(c));
  });
});

describe("ProfileCollector.record / measure", () => {
  it("record returns a successor collector; receiver never mutates", () => {
    const collector = createProfileCollector();
    const { collector: next, sample } = collector.record({
      stage: "workflow",
      name: "wf",
      durationMs: 10,
      startedAt: NOW,
    });
    expect(sample.durationMs).toBe(10);
    expect(collector.count()).toBe(0);
    expect(next.count()).toBe(1);
  });

  it("measure uses the injected clock, never Date.now", async () => {
    const collector = createProfileCollector();
    let clock = 100;
    const { collector: next, durationMs, result } = await collector.measure(
      {
        stage: "tool",
        name: "search",
        startedAt: NOW,
        clockMs: () => clock,
      },
      async () => {
        clock = 150;
        return "ok";
      },
    );
    expect(durationMs).toBe(50);
    expect(result).toBe("ok");
    expect(next.count()).toBe(1);
    expect(next.list()[0]?.durationMs).toBe(50);
  });

  it("measure clamps negative durations to zero", async () => {
    const collector = createProfileCollector();
    let clock = 200;
    const { collector: next, durationMs } = await collector.measure(
      { stage: "api", name: "req", startedAt: NOW, clockMs: () => clock },
      async () => {
        clock = 100;
        return undefined;
      },
    );
    expect(durationMs).toBe(0);
    expect(next.list()[0]?.durationMs).toBe(0);
  });

  it("bounds retained samples with maxSamples", () => {
    const collector = new ProfileCollector({ maxSamples: 2 });
    let current = collector;
    for (let index = 0; index < 3; index += 1) {
      const { collector: next } = current.record({
        stage: "api",
        name: "req",
        durationMs: index,
        startedAt: NOW,
      });
      current = next;
    }
    expect(current.count()).toBe(2);
  });
});

describe("aggregation", () => {
  it("profileStatistics aggregates empty samples", () => {
    const stats = profileStatistics([]);
    expect(stats.count).toBe(0);
    expect(stats.totalMs).toBe(0);
    expect(stats.minMs).toBeUndefined();
  });

  it("profileStatistics computes min/max/average/percentiles", () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((durationMs) =>
      createProfileSample({ stage: "api", name: "req", durationMs, startedAt: NOW }),
    );
    const stats = profileStatistics(samples);
    expect(stats.count).toBe(10);
    expect(stats.totalMs).toBe(550);
    expect(stats.minMs).toBe(10);
    expect(stats.maxMs).toBe(100);
    expect(stats.averageMs).toBe(55);
    expect(stats.p50).toBe(50);
    expect(stats.p95).toBe(100);
  });

  it("profileStatisticsByStage covers every stage", () => {
    const collector = createProfileCollector();
    const { collector: next } = collector.record({
      stage: "planner",
      name: "plan",
      durationMs: 3,
      startedAt: NOW,
    });
    const byStage = next.statisticsByStage();
    for (const stage of PROFILE_STAGES) {
      expect(byStage[stage]).toBeDefined();
    }
    expect(byStage.planner.count).toBe(1);
    expect(byStage.api.count).toBe(0);
  });

  it("profileSeries orders samples by stage", () => {
    const collector = createProfileCollector();
    let current = collector;
    current = current.record({ stage: "tool", name: "a", durationMs: 1, startedAt: NOW }).collector;
    current = current.record({ stage: "tool", name: "b", durationMs: 3, startedAt: NOW }).collector;
    current = current.record({ stage: "api", name: "c", durationMs: 2, startedAt: NOW }).collector;
    const series = profileSeries(current.samples, "tool");
    expect(series.count).toBe(2);
    expect(series.totalMs).toBe(4);
    expect(series.averageMs).toBe(2);
  });

  it("profileSummaries lists observed stages in canonical order", () => {
    const collector = createProfileCollector();
    let current = collector;
    current = current.record({ stage: "database", name: "q", durationMs: 1, startedAt: NOW }).collector;
    current = current.record({ stage: "api", name: "r", durationMs: 2, startedAt: NOW }).collector;
    const summaries = current.summaries();
    expect(summaries.map((summary) => summary.stage)).toEqual(["database", "api"]);
  });
});

describe("report / snapshot", () => {
  it("builds a deterministic report at `at`", () => {
    const collector = createProfileCollector();
    const { collector: next } = collector.record({
      stage: "workflow",
      name: "wf",
      durationMs: 7,
      startedAt: NOW,
    });
    const report = next.report(NOW);
    expect(report.at).toBe(NOW);
    expect(report.statistics.totalMs).toBe(7);
    expect(report.summaries).toHaveLength(1);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it("snapshot is frozen with samples and statistics", () => {
    const collector = createProfileCollector();
    const { collector: next } = collector.record({
      stage: "worker_execution",
      name: "w1",
      durationMs: 4,
      startedAt: NOW,
    });
    const snapshot = next.snapshot(NOW);
    expect(snapshot.samples).toHaveLength(1);
    expect(snapshot.statistics.averageMs).toBe(4);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("find filters by stage", () => {
    const collector = createProfileCollector();
    let current = collector;
    current = current.record({ stage: "database", name: "q", durationMs: 1, startedAt: NOW }).collector;
    current = current.record({ stage: "api", name: "r", durationMs: 2, startedAt: NOW }).collector;
    expect(current.find("database")).toHaveLength(1);
    expect(current.find("api")).toHaveLength(1);
    expect(current.find("llm")).toHaveLength(0);
  });
});

describe("PROFILE_STAGES", () => {
  it("covers every measured stage", () => {
    const stages: readonly ProfileStage[] = [
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
    ];
    expect(PROFILE_STAGES).toEqual(stages);
  });
});
