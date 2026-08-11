import { describe, it, expect } from "vitest";
import {
  createWorker,
  cloneWorker,
  freezeWorker,
  touchWorker,
  workerIdFor,
  hashWorker,
  estimateWorkerCost,
  createWorkerReference,
  createWorkerSummary,
  isWorkerAvailable,
  isWorkerHealthy,
  createWorkerTask,
  cloneWorkerTask,
  freezeWorkerTask,
  touchWorkerTask,
  taskIdFor,
  isTaskRunnable,
  createWorkerLease,
  cloneWorkerLease,
  freezeWorkerLease,
  isLeaseActive,
  leaseIdFor,
  createWorkerExecution,
  createWorkerHeartbeat,
  createWorkerPool,
  createWorkerBatch,
  createWorkerSignal,
  createWorkerEvent,
  createWorkerConfiguration,
  createWorkerStatistics,
  createWorkerMetrics,
  createWorkerSnapshot,
  createWorkerReport,
  PRIORITY_RANK,
} from "@/lib/workers/types";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:00:01.000Z";

describe("createWorker", () => {
  it("builds a worker with deterministic defaults", () => {
    const worker = createWorker({ name: "alpha", pool: "main", createdAt: NOW });
    expect(worker.id).toBe(workerIdFor("alpha", "main", NOW));
    expect(worker.status).toBe("registered");
    expect(worker.state).toBe("idle");
    expect(worker.priority).toBe("normal");
    expect(worker.capacity.maxConcurrent).toBe(1);
    expect(worker.capacity.busy).toBe(0);
    expect(worker.failures).toBe(0);
    expect(worker.restartCount).toBe(0);
    expect(worker.health.status).toBe("unknown");
    expect(worker.history).toEqual([]);
  });

  it("honors explicit ids and overrides", () => {
    const worker = createWorker({
      id: "worker-1",
      name: "alpha",
      pool: "main",
      priority: "critical",
      capabilities: ["gmail", "calendar"],
      capacity: { maxConcurrent: 4, weight: 2 },
      createdAt: NOW,
    });
    expect(worker.id).toBe("worker-1");
    expect(worker.priority).toBe("critical");
    expect(worker.capabilities).toEqual(["gmail", "calendar"]);
    expect(worker.capacity.maxConcurrent).toBe(4);
    expect(worker.capacity.weight).toBe(2);
  });

  it("is deterministic for identical inputs", () => {
    const a = createWorker({ name: "alpha", pool: "main", createdAt: NOW });
    const b = createWorker({ name: "alpha", pool: "main", createdAt: NOW });
    expect(a.id).toBe(b.id);
    expect(hashWorker(a)).toBe(hashWorker(b));
  });

  it("produces distinct ids for distinct names", () => {
    const a = createWorker({ name: "alpha", pool: "main", createdAt: NOW });
    const b = createWorker({ name: "beta", pool: "main", createdAt: NOW });
    expect(a.id).not.toBe(b.id);
  });
});

describe("cloneWorker / freezeWorker", () => {
  it("clones deeply (mutating the clone never affects the source)", () => {
    const worker = freezeWorker(
      createWorker({ name: "alpha", pool: "main", createdAt: NOW }),
    );
    const clone = cloneWorker(worker);
    clone.capabilities.push("extra");
    clone.capacity.busy = 3;
    clone.history.push({ at: NOW, kind: "state.change" });
    expect(worker.capabilities).toEqual([]);
    expect(worker.capacity.busy).toBe(0);
    expect(worker.history).toEqual([]);
  });

  it("freezes every nested structure", () => {
    const worker = freezeWorker(
      createWorker({ name: "alpha", pool: "main", createdAt: NOW }),
    );
    expect(Object.isFrozen(worker)).toBe(true);
    expect(Object.isFrozen(worker.capacity)).toBe(true);
    expect(Object.isFrozen(worker.limits)).toBe(true);
    expect(Object.isFrozen(worker.registration)).toBe(true);
    expect(Object.isFrozen(worker.health)).toBe(true);
    expect(Object.isFrozen(worker.metadata.tags)).toBe(true);
    expect(() => {
      (worker as { name: string }).name = "mutated";
    }).toThrow();
  });
});

describe("touchWorker", () => {
  it("returns a successor without mutating the input", () => {
    const worker = createWorker({ name: "alpha", pool: "main", createdAt: NOW });
    const next = touchWorker(worker, {
      status: "running",
      state: "running",
      lastHeartbeatAt: LATER,
      updatedAt: LATER,
    });
    expect(worker.status).toBe("registered");
    expect(next.status).toBe("running");
    expect(next.updatedAt).toBe(LATER);
    expect(next.id).toBe(worker.id);
  });

  it("clears optional fields when patched to null", () => {
    const worker = createWorker({ name: "alpha", pool: "main", createdAt: NOW });
    const started = touchWorker(worker, {
      status: "running",
      startedAt: LATER,
      updatedAt: LATER,
    });
    expect(started.startedAt).toBe(LATER);
    const stopped = touchWorker(started, { status: "stopped", startedAt: null, updatedAt: LATER });
    expect(stopped.startedAt).toBeUndefined();
  });
});

describe("isWorkerHealthy / isWorkerAvailable", () => {
  it("treats workers without a heartbeat as healthy", () => {
    const worker = createWorker({ name: "alpha", pool: "main", createdAt: NOW });
    expect(isWorkerHealthy(worker, NOW)).toBe(true);
  });

  it("detects stale heartbeats", () => {
    const worker = createWorker({ name: "alpha", pool: "main", createdAt: NOW });
    const beat = touchWorker(worker, { lastHeartbeatAt: "2026-08-11T08:00:00.000Z", updatedAt: NOW });
    expect(isWorkerHealthy(beat, NOW)).toBe(false);
  });

  it("is unavailable when busy at capacity", () => {
    const worker = createWorker({
      name: "alpha",
      pool: "main",
      capacity: { maxConcurrent: 1, weight: 1 },
      createdAt: NOW,
    });
    const idle = touchWorker(worker, { status: "idle", updatedAt: NOW });
    expect(isWorkerAvailable(idle, NOW)).toBe(true);
    const busy = touchWorker(idle, { status: "busy", state: "busy", capacity: { busy: 1 }, updatedAt: NOW });
    expect(isWorkerAvailable(busy, NOW)).toBe(false);
  });
});

describe("estimateWorkerCost / reference / summary", () => {
  it("weights capacity by concurrency and weight", () => {
    const worker = createWorker({
      name: "alpha",
      pool: "main",
      capacity: { maxConcurrent: 3, weight: 2 },
      createdAt: NOW,
    });
    expect(estimateWorkerCost(worker)).toBe(6);
  });

  it("builds stable references and summaries", () => {
    const worker = createWorker({ name: "alpha", pool: "main", createdAt: NOW });
    expect(createWorkerReference(worker)).toEqual({ id: worker.id, kind: "worker", name: "alpha" });
    const summary = createWorkerSummary(worker);
    expect(summary.id).toBe(worker.id);
    expect(summary.health.score).toBe(1);
  });
});

describe("createWorkerTask", () => {
  it("builds a task with deterministic defaults", () => {
    const task = createWorkerTask({
      name: "digest",
      kind: "digest",
      payload: { template: "morning", userId: "u1" },
      createdAt: NOW,
    });
    expect(task.id).toBe(taskIdFor("digest", "digest", "normal", NOW));
    expect(task.status).toBe("pending");
    expect(task.attempts).toBe(0);
    expect(task.maxAttempts).toBe(1);
    expect(task.priority).toBe("normal");
    expect(task.archived).toBe(false);
  });

  it("marks scheduled tasks when scheduledAt is provided", () => {
    const task = createWorkerTask({
      name: "digest",
      kind: "digest",
      payload: { template: "morning", userId: "u1" },
      createdAt: NOW,
      scheduledAt: LATER,
    });
    expect(task.status).toBe("scheduled");
    expect(isTaskRunnable(task, NOW)).toBe(false);
    expect(isTaskRunnable(task, LATER)).toBe(true);
  });

  it("keeps payload and retry policy detached", () => {
    const retry = { maxRetries: 2, backoffMs: 100 };
    const task = createWorkerTask({
      name: "job",
      kind: "job",
      payload: { jobId: "j1" },
      retryPolicy: retry,
      createdAt: NOW,
    });
    expect(task.retryPolicy?.maxRetries).toBe(2);
    expect(task.payload).toEqual({ jobId: "j1" });
  });
});

describe("cloneWorkerTask / freezeWorkerTask / touchWorkerTask", () => {
  it("clones deeply", () => {
    const task = createWorkerTask({
      name: "job",
      kind: "job",
      payload: { jobId: "j1" },
      createdAt: NOW,
    });
    const clone = cloneWorkerTask(task);
    clone.dependencies.push("d1");
    clone.history.push({ at: NOW, kind: "state.change" });
    expect(task.dependencies).toEqual([]);
    expect(task.history).toEqual([]);
  });

  it("freezes nested structures", () => {
    const task = freezeWorkerTask(
      createWorkerTask({
        name: "job",
        kind: "job",
        payload: { jobId: "j1" },
        retryPolicy: { maxRetries: 1, backoffMs: 5 },
        createdAt: NOW,
      }),
    );
    expect(Object.isFrozen(task)).toBe(true);
    expect(Object.isFrozen(task.payload)).toBe(true);
    expect(Object.isFrozen(task.metadata.tags)).toBe(true);
  });

  it("applies successor patches without mutating", () => {
    const task = createWorkerTask({
      name: "job",
      kind: "job",
      payload: { jobId: "j1" },
      createdAt: NOW,
    });
    const started = touchWorkerTask(task, { status: "leased", attempts: 1, startedAt: LATER });
    expect(task.status).toBe("pending");
    expect(started.status).toBe("leased");
    expect(started.attempts).toBe(1);
    const cleared = touchWorkerTask(started, { error: null, startedAt: null });
    expect(cleared.error).toBeUndefined();
    expect(cleared.startedAt).toBeUndefined();
  });
});

describe("leases", () => {
  it("derives deterministic ids", () => {
    const lease = createWorkerLease({
      taskId: "t1",
      workerId: "w1",
      acquiredAt: NOW,
      expiresAt: LATER,
    });
    expect(lease.id).toBe(leaseIdFor("t1", "w1", NOW));
    expect(lease.status).toBe("active");
  });

  it("expires leases by injected time", () => {
    const lease = createWorkerLease({
      taskId: "t1",
      workerId: "w1",
      acquiredAt: NOW,
      expiresAt: LATER,
    });
    expect(isLeaseActive(lease, NOW)).toBe(true);
    expect(isLeaseActive(lease, LATER)).toBe(false);
  });

  it("clones and freezes", () => {
    const lease = createWorkerLease({
      taskId: "t1",
      workerId: "w1",
      acquiredAt: NOW,
      expiresAt: LATER,
    });
    const clone = cloneWorkerLease(lease);
    expect(clone).toEqual(lease);
    expect(Object.isFrozen(freezeWorkerLease(lease))).toBe(true);
  });
});

describe("executions / heartbeats", () => {
  it("builds execution records with deterministic ids", () => {
    const exec = createWorkerExecution({
      taskId: "t1",
      workerId: "w1",
      attempt: 1,
      startedAt: NOW,
    });
    expect(exec.status).toBe("running");
    expect(exec.id.startsWith("exec-")).toBe(true);
  });

  it("builds frozen heartbeats", () => {
    const heartbeat = createWorkerHeartbeat("w1", NOW, "busy");
    expect(heartbeat.workerId).toBe("w1");
    expect(heartbeat.state).toBe("busy");
    expect(Object.isFrozen(heartbeat)).toBe(true);
  });
});

describe("pools / batches / signals / events", () => {
  it("builds pools with deterministic ids", () => {
    const pool = createWorkerPool({ name: "main", createdAt: NOW });
    expect(pool.size).toBe(0);
    const pool2 = createWorkerPool({ name: "main", workerIds: ["w1"], createdAt: NOW });
    expect(pool2.size).toBe(1);
  });

  it("builds batches", () => {
    const batch = createWorkerBatch({ taskIds: ["t1", "t2"], createdAt: NOW });
    expect(batch.status).toBe("pending");
    expect(batch.taskIds).toEqual(["t1", "t2"]);
  });

  it("builds deterministic signals and events", () => {
    const signal = createWorkerSignal({ kind: "stop", workerId: "w1", at: NOW, reason: "rebalance" });
    expect(signal.reason).toBe("rebalance");
    const event = createWorkerEvent({ type: "task.completed", taskId: "t1", at: NOW });
    expect(event.taskId).toBe("t1");
    expect(event.id.startsWith("wevent-")).toBe(true);
  });
});

describe("configuration / statistics / metrics / snapshot / report", () => {
  it("builds deterministic default configuration", () => {
    const config = createWorkerConfiguration();
    expect(config.leaseDurationMs).toBe(30_000);
    expect(config.heartbeatTimeoutMs).toBe(60_000);
    expect(config.maxRestarts).toBe(3);
    expect(config.retryPolicy.maxRetries).toBe(0);
    expect(Object.isFrozen(config.retryPolicy)).toBe(true);
  });

  it("honors overrides and keeps frozen", () => {
    const config = createWorkerConfiguration({
      capacity: { maxConcurrent: 5 },
      retryPolicy: { maxRetries: 4, retryableCodes: ["timeout"] },
    });
    expect(config.capacity.maxConcurrent).toBe(5);
    expect(config.limits.maxTasks).toBe(5);
    expect(config.retryPolicy.maxRetries).toBe(4);
    expect(config.retryPolicy.retryableCodes).toEqual(["timeout"]);
    expect(Object.isFrozen(config.capacity)).toBe(true);
    expect(Object.isFrozen(config.retryPolicy.retryableCodes)).toBe(true);
  });

  it("counts statistics with defaults", () => {
    const stats = createWorkerStatistics({
      workers: { idle: 2, busy: 1 },
      tasks: { completed: 5 },
      leases: { active: 1, total: 1 },
    });
    expect(stats.workers.idle).toBe(2);
    expect(stats.workers.busy).toBe(1);
    expect(stats.workers.registered).toBe(0);
    expect(stats.tasks.completed).toBe(5);
    expect(stats.leases.total).toBe(1);
  });

  it("builds metrics with defaults", () => {
    const metrics = createWorkerMetrics({ tasksCompleted: 3, totalDurationMs: 42 });
    expect(metrics.tasksCompleted).toBe(3);
    expect(metrics.tasksFailed).toBe(0);
    expect(metrics.totalDurationMs).toBe(42);
  });

  it("builds a frozen snapshot", () => {
    const worker = createWorker({ name: "alpha", pool: "main", createdAt: NOW });
    const snapshot = createWorkerSnapshot({ at: NOW, workers: [worker] });
    expect(snapshot.workers).toHaveLength(1);
    expect(Object.isFrozen(snapshot.workers)).toBe(true);
    expect(snapshot.statistics.workers.registered).toBe(0);
  });

  it("builds reports", () => {
    const worker = createWorker({ name: "alpha", pool: "main", createdAt: NOW });
    const report = createWorkerReport({
      workerId: worker.id,
      at: NOW,
      health: worker.health,
      metrics: createWorkerMetrics(),
      summary: createWorkerSummary(worker),
    });
    expect(report.workerId).toBe(worker.id);
    expect(Object.isFrozen(report)).toBe(true);
  });
});

describe("PRIORITY_RANK", () => {
  it("orders critical > high > normal > low", () => {
    expect(PRIORITY_RANK.critical).toBeGreaterThan(PRIORITY_RANK.high);
    expect(PRIORITY_RANK.high).toBeGreaterThan(PRIORITY_RANK.normal);
    expect(PRIORITY_RANK.normal).toBeGreaterThan(PRIORITY_RANK.low);
  });
});
