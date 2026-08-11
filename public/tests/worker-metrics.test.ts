import { describe, it, expect } from "vitest";
import {
  computeWorkerMetrics,
  computeQueueDepth,
  averageLatencyMs,
  throughputPerWindow,
  utilization,
  heartbeatLatencyMs,
  successRate,
  failureRate,
  retryRate,
  computePoolMetrics,
  buildWorkerReport,
  buildHealthReport,
  computeStatistics,
} from "@/lib/workers/metrics";
import { WorkerManager } from "@/lib/workers/manager";
import { createWorkerExecution } from "@/lib/workers/types";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:01:00.000Z";

function taskInput(name: string, extra: Record<string, unknown> = {}) {
  return { name, kind: "job" as const, payload: { jobId: `job-${name}` }, createdAt: NOW, ...extra };
}

function makeWorker(name: string, extra: Record<string, unknown> = {}) {
  return { name, pool: "main", createdAt: NOW, ...extra };
}

/** Run a full lease→complete cycle and return the settled manager. */
async function settledManager(): Promise<WorkerManager> {
  let manager = new WorkerManager();
  const { manager: a, worker } = manager.registerWorker(makeWorker("alpha", { id: "w1" }));
  manager = a;
  const { manager: b } = manager.startWorker(worker.id, NOW);
  manager = b;
  const { manager: c } = manager.enqueueTask(taskInput("t1"), NOW);
  manager = c;
  const leased = manager.leaseTask(worker.id, NOW);
  manager = leased?.manager ?? manager;
  manager = manager.completeTask(leased?.task.id ?? "", worker.id, LATER, { ok: true }, 100).manager;
  return manager;
}

describe("computeWorkerMetrics", () => {
  it("counts completed, failed, cancelled and durations", () => {
    const executions = [
      createWorkerExecution({ taskId: "t1", workerId: "w1", attempt: 1, startedAt: NOW, status: "completed", finishedAt: LATER, durationMs: 100 }),
      createWorkerExecution({ taskId: "t2", workerId: "w1", attempt: 1, startedAt: NOW, status: "failed", finishedAt: LATER, durationMs: 50 }),
      createWorkerExecution({ taskId: "t3", workerId: "w2", attempt: 1, startedAt: NOW, status: "cancelled", finishedAt: LATER, durationMs: 10 }),
    ];
    const manager = new WorkerManager({ executions });
    const metrics = computeWorkerMetrics(manager, "w1");
    expect(metrics.tasksCompleted).toBe(1);
    expect(metrics.tasksFailed).toBe(1);
    expect(metrics.tasksCancelled).toBe(0);
    expect(metrics.totalRuns).toBe(2);
    expect(metrics.totalDurationMs).toBe(150);
  });

  it("metrics are immutable", () => {
    const manager = new WorkerManager();
    const metrics = computeWorkerMetrics(manager);
    expect(Object.isFrozen(metrics)).toBe(true);
  });
});

describe("queue depth / latency / throughput", () => {
  it("reports queue depth across queues", async () => {
    const manager = await settledManager();
    const depth = computeQueueDepth(manager, NOW);
    expect(depth.total).toBe(0);
    expect(depth.pending).toBe(0);
  });

  it("averages settled latencies", () => {
    const executions = [
      createWorkerExecution({ taskId: "t1", workerId: "w1", attempt: 1, startedAt: NOW, status: "completed", finishedAt: LATER, durationMs: 100 }),
      createWorkerExecution({ taskId: "t2", workerId: "w1", attempt: 1, startedAt: NOW, status: "completed", finishedAt: LATER, durationMs: 200 }),
    ];
    expect(averageLatencyMs(executions)).toBe(150);
    expect(averageLatencyMs([])).toBe(0);
  });

  it("counts completed executions within a window", () => {
    const executions = [
      createWorkerExecution({ taskId: "t1", workerId: "w1", attempt: 1, startedAt: NOW, status: "completed", finishedAt: NOW }),
      createWorkerExecution({ taskId: "t2", workerId: "w1", attempt: 1, startedAt: "2026-08-10T00:00:00.000Z", status: "completed", finishedAt: "2026-08-10T00:00:00.000Z" }),
    ];
    expect(throughputPerWindow(executions, NOW, 60_000)).toBe(1);
  });
});

describe("rates and utilization", () => {
  it("computes success/failure/retry rates", () => {
    const metrics = {
      tasksCompleted: 8,
      tasksFailed: 1,
      tasksCancelled: 1,
      tasksRetried: 1,
      totalRuns: 10,
      totalDurationMs: 0,
      queueDepth: 0,
    };
    expect(successRate(metrics)).toBe(0.8);
    expect(failureRate(metrics)).toBe(0.1);
    expect(retryRate(metrics)).toBe(0.1);
    expect(successRate(createWorkerMetricsEquivalent())).toBe(0);
  });

  it("computes utilization from busy slots over capacity", async () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(
      makeWorker("alpha", { id: "w1", capacity: { maxConcurrent: 4 } }),
    );
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c } = manager.enqueueTask(taskInput("t1"), NOW);
    manager = c;
    const leased = manager.leaseTask(worker.id, NOW);
    expect(utilization(leased?.manager ?? manager)).toBe(0.25);
    expect(utilization(new WorkerManager())).toBe(0);
  });

  it("computes heartbeat latency", () => {
    expect(heartbeatLatencyMs({ lastHeartbeatAt: NOW }, LATER)).toBe(60_000);
    expect(heartbeatLatencyMs({}, NOW)).toBe(0);
  });
});

describe("pool metrics / reports / health", () => {
  it("builds a pool metrics report", async () => {
    const manager = await settledManager();
    const report = computePoolMetrics(manager, NOW);
    expect(report.metrics.tasksCompleted).toBe(1);
    expect(report.averageLatencyMs).toBe(100);
    expect(report.successRate).toBe(1);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it("builds per-worker reports", async () => {
    const manager = await settledManager();
    const report = buildWorkerReport(manager, "w1", NOW);
    expect(report?.workerId).toBe("w1");
    expect(report?.metrics.tasksCompleted).toBe(1);
    expect(buildWorkerReport(manager, "missing", NOW)).toBeUndefined();
  });

  it("builds a health report over every worker", async () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha", { id: "w1" }));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c } = manager.heartbeat(worker.id, NOW);
    manager = c;
    const health = buildHealthReport(manager, NOW);
    expect(health.reports).toHaveLength(1);
    expect(health.aggregate.healthy).toBe(1);
    expect(health.dead).toEqual([]);
  });

  it("computes statistics immutably", async () => {
    const manager = await settledManager();
    const stats = computeStatistics(manager);
    expect(stats.tasks.completed).toBe(1);
    expect(Object.isFrozen(stats)).toBe(true);
  });
});

function createWorkerMetricsEquivalent() {
  return {
    tasksCompleted: 0,
    tasksFailed: 0,
    tasksCancelled: 0,
    tasksRetried: 0,
    totalRuns: 0,
    totalDurationMs: 0,
    queueDepth: 0,
  };
}
