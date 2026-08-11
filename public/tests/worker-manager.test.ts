import { describe, it, expect } from "vitest";
import {
  WorkerManager,
  WorkerTaskDuplicateError,
  WorkerUnavailableError,
  retryDelayFor,
} from "@/lib/workers/manager";
import { createWorkerConfiguration } from "@/lib/workers/types";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:01:00.000Z";
const MUCH_LATER = "2026-08-11T09:05:00.000Z";

function taskInput(name: string, extra: Partial<Parameters<WorkerManager["enqueueTask"]>[0]> = {}) {
  return {
    name,
    kind: "job" as const,
    payload: { jobId: `job-${name}` },
    createdAt: NOW,
    ...extra,
  };
}

function makeWorker(name: string, extra: Record<string, unknown> = {}) {
  return { name, pool: "main", createdAt: NOW, ...extra };
}

describe("worker lifecycle", () => {
  it("registers and starts workers via successor", () => {
    const manager = new WorkerManager();
    const { manager: withWorker, worker } = manager.registerWorker(makeWorker("alpha"));
    expect(manager.countWorkers()).toBe(0);
    expect(withWorker.countWorkers()).toBe(1);
    const { manager: started, worker: startedWorker } = withWorker.startWorker(worker.id, NOW);
    expect(startedWorker.status).toBe("running");
    expect(started.find(worker.id)?.status).toBe("running");
    expect(withWorker.find(worker.id)?.status).toBe("registered");
  });

  it("pause/resume/stop/restart transition state", () => {
    const { manager: a, worker } = new WorkerManager().registerWorker(makeWorker("alpha"));
    const { manager: b } = a.startWorker(worker.id, NOW);
    const { manager: c, worker: paused } = b.pauseWorker(worker.id, NOW);
    expect(paused.status).toBe("paused");
    const { manager: d, worker: resumed } = c.resumeWorker(worker.id, LATER);
    expect(resumed.status).toBe("running");
    const { manager: e, worker: stopped } = d.stopWorker(worker.id, MUCH_LATER, "rebalance");
    expect(stopped.status).toBe("stopped");
    expect(stopped.stoppedAt).toBe(MUCH_LATER);
    const { worker: restarted } = e.restartWorker(worker.id, MUCH_LATER);
    expect(restarted.status).toBe("running");
    expect(restarted.restartCount).toBe(1);
  });

  it("heartbeat records freshness and renews leases", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.enqueueTask(taskInput("t1"), NOW);
    manager = b;
    const { manager: c } = manager.startWorker(worker.id, NOW);
    manager = c;
    const leased = manager.leaseTask(worker.id, NOW);
    expect(leased).toBeDefined();
    manager = leased?.manager ?? manager;
    const lease = leased?.lease;
    expect(lease?.expiresAt).toBe("2026-08-11T09:00:30.000Z");
    const { manager: d, worker: beat } = manager.heartbeat(worker.id, LATER);
    expect(beat.lastHeartbeatAt).toBe(LATER);
    expect(beat.health.status).toBe("healthy");
    const renewed = d.listLeases().find((entry) => entry.id === lease?.id);
    expect(renewed?.expiresAt).toBe("2026-08-11T09:01:30.000Z");
  });

  it("stopWorker releases active leases and frees slots", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c } = manager.enqueueTask(taskInput("t1"), NOW);
    manager = c;
    manager = manager.leaseTask(worker.id, NOW)?.manager ?? manager;
    const { manager: d, worker: stopped } = manager.stopWorker(worker.id, LATER);
    expect(stopped.capacity.busy).toBe(0);
    const released = d.listLeases().filter((lease) => lease.workerId === worker.id);
    expect(released.every((lease) => lease.status !== "active")).toBe(true);
  });
});

describe("task enqueue + advance", () => {
  it("enqueues due tasks into pending and scheduled tasks into delayed", () => {
    let manager = new WorkerManager();
    const { manager: a } = manager.enqueueTask(taskInput("now"), NOW);
    manager = a;
    const { manager: b } = manager.enqueueTask(
      taskInput("later", { scheduledAt: LATER }),
      NOW,
    );
    expect(b.pending.containsTask(a.tasks[0]?.id ?? "")).toBe(true);
    const laterTask = b.findTask(b.tasks[1]?.id ?? "");
    expect(laterTask?.status).toBe("scheduled");
    expect(b.delayed.containsTask(laterTask?.id ?? "")).toBe(true);
  });

  it("rejects duplicate task ids", () => {
    const manager = new WorkerManager();
    const { manager: a } = manager.enqueueTask(taskInput("t1", { id: "task-x" }), NOW);
    expect(() => a.enqueueTask(taskInput("t2", { id: "task-x" }), NOW)).toThrow(
      WorkerTaskDuplicateError,
    );
  });

  it("advance promotes due delayed and retry items into pending", () => {
    let manager = new WorkerManager();
    const { manager: a, task } = manager.enqueueTask(
      taskInput("later", { scheduledAt: LATER }),
      NOW,
    );
    manager = a;
    expect(manager.pending.containsTask(task.id)).toBe(false);
    const { manager: b, promoted } = manager.advance(LATER);
    expect(promoted.map((t) => t.id)).toEqual([task.id]);
    expect(b.pending.containsTask(task.id)).toBe(true);
    expect(b.findTask(task.id)?.status).toBe("pending");
  });

  it("advance is a no-op when nothing is due", () => {
    const manager = new WorkerManager();
    const { manager: a } = manager.enqueueTask(taskInput("later", { scheduledAt: LATER }), NOW);
    const { manager: b, promoted } = a.advance(NOW);
    expect(promoted).toEqual([]);
    expect(b).toBe(a);
  });
});

describe("lease / assign", () => {
  it("leases the highest-priority ready task", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c } = manager.enqueueTask(taskInput("low", { priority: "low" }), NOW);
    manager = c;
    const { manager: d } = manager.enqueueTask(taskInput("crit", { priority: "critical" }), NOW);
    manager = d;
    const leased = manager.leaseTask(worker.id, NOW);
    expect(leased?.task.name).toBe("crit");
    expect(leased?.lease.status).toBe("active");
    expect(leased?.execution.status).toBe("running");
    expect(leased?.manager.findTask(leased.task.id)?.status).toBe("leased");
    expect(leased?.manager.find(worker.id)?.capacity.busy).toBe(1);
    expect(leased?.manager.pending.containsTask(leased.task.id)).toBe(false);
  });

  it("skips tasks whose dependencies are unsatisfied", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c, task: dependent } = manager.enqueueTask(
      taskInput("dependent", { dependencies: ["task-missing"] }),
      NOW,
    );
    manager = c;
    const { manager: d } = manager.enqueueTask(taskInput("ready"), NOW);
    manager = d;
    const leased = manager.leaseTask(worker.id, NOW);
    expect(leased?.task.id).not.toBe(dependent.id);
    expect(leased?.task.name).toBe("ready");
  });

  it("assignTask leases a specific pending task", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c, task } = manager.enqueueTask(taskInput("specific"), NOW);
    const assigned = c.assignTask(worker.id, task.id, NOW);
    expect(assigned.task.id).toBe(task.id);
  });

  it("refuses leases to unavailable workers", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.enqueueTask(taskInput("t1"), NOW);
    manager = b;
    const leased = manager.leaseTask(worker.id, NOW);
    expect(leased).toBeUndefined();
    expect(() => manager.assignTask(worker.id, b.tasks[0]?.id ?? "", NOW)).toThrow(
      WorkerUnavailableError,
    );
  });
});

describe("complete / fail / cancel", () => {
  it("completes a leased task and frees the worker slot", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c } = manager.enqueueTask(taskInput("t1"), NOW);
    manager = c;
    const leased = manager.leaseTask(worker.id, NOW);
    manager = leased?.manager ?? manager;
    const taskId = leased?.task.id ?? "";
    const { manager: d, task } = manager.completeTask(taskId, worker.id, LATER, { ok: true }, 42);
    expect(task.status).toBe("completed");
    expect(task.result?.durationMs).toBe(42);
    expect(d.find(worker.id)?.capacity.busy).toBe(0);
    const execution = d.listExecutions().find((entry) => entry.taskId === taskId);
    expect(execution?.status).toBe("completed");
    expect(execution?.finishedAt).toBe(LATER);
  });

  it("fails with retries left → moves to retry queue with backoff", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c } = manager.enqueueTask(
      taskInput("flaky", {
        maxAttempts: 3,
        retryPolicy: { maxRetries: 2, backoffMs: 1000 },
      }),
      NOW,
    );
    manager = c;
    const leased = manager.leaseTask(worker.id, NOW);
    manager = leased?.manager ?? manager;
    const { manager: d, task } = manager.failTask(
      leased?.task.id ?? "",
      worker.id,
      LATER,
      { code: "handler_error", message: "boom", retryable: true },
    );
    expect(task.status).toBe("retrying");
    expect(d.retry.containsTask(task.id)).toBe(true);
    const item = d.retry.findByTask(task.id);
    expect(item?.dequeueAt).toBe("2026-08-11T09:01:01.000Z");
    expect(d.findTask(task.id)?.attempts).toBe(1);
  });

  it("fails without retries left → dead letter", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c } = manager.enqueueTask(taskInput("fatal"), NOW);
    manager = c;
    const leased = manager.leaseTask(worker.id, NOW);
    manager = leased?.manager ?? manager;
    const { manager: d, task } = manager.failTask(
      leased?.task.id ?? "",
      worker.id,
      LATER,
      { code: "handler_error", message: "boom" },
    );
    expect(task.status).toBe("dead");
    expect(d.deadLetter.hasTask(task.id)).toBe(true);
    expect(d.pending.containsTask(task.id)).toBe(false);
  });

  it("only retries retryable codes when restricted", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c } = manager.enqueueTask(
      taskInput("restricted", {
        maxAttempts: 3,
        retryPolicy: { maxRetries: 2, backoffMs: 100, retryableCodes: ["timeout"] },
      }),
      NOW,
    );
    manager = c;
    const leased = manager.leaseTask(worker.id, NOW);
    manager = leased?.manager ?? manager;
    const { manager: d, task } = manager.failTask(
      leased?.task.id ?? "",
      worker.id,
      LATER,
      { code: "handler_error", message: "not retryable" },
    );
    expect(task.status).toBe("dead");
    expect(d.retry.containsTask(task.id)).toBe(false);
  });

  it("cancels a leased task and removes it from queues", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c } = manager.enqueueTask(taskInput("t1"), NOW);
    manager = c;
    const leased = manager.leaseTask(worker.id, NOW);
    manager = leased?.manager ?? manager;
    const { manager: d, task } = manager.cancelTask(leased?.task.id ?? "", LATER, {
      code: "cancelled",
      message: "aborted",
    });
    expect(task.status).toBe("cancelled");
    expect(d.find(worker.id)?.capacity.busy).toBe(0);
    const execution = d.listExecutions().find((entry) => entry.taskId === leased?.task.id);
    expect(execution?.status).toBe("cancelled");
  });

  it("retryTask manually re-queues a retrying/dead task", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c } = manager.enqueueTask(
      taskInput("fatal", { retryPolicy: { maxRetries: 1, backoffMs: 5 } }),
      NOW,
    );
    manager = c;
    const leased = manager.leaseTask(worker.id, NOW);
    manager = leased?.manager ?? manager;
    const { manager: d } = manager.failTask(leased?.task.id ?? "", worker.id, LATER, {
      code: "x",
      message: "y",
    });
    const { manager: e, task } = d.retryTask(leased?.task.id ?? "", MUCH_LATER);
    expect(task.status).toBe("pending");
    expect(e.pending.containsTask(task.id)).toBe(true);
    expect(e.deadLetter.hasTask(task.id)).toBe(false);
  });

  it("markRunning flips leased → running", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c } = manager.enqueueTask(taskInput("t1"), NOW);
    manager = c;
    const leased = manager.leaseTask(worker.id, NOW);
    manager = leased?.manager ?? manager;
    const { manager: d, task } = manager.markRunning(leased?.task.id ?? "", NOW);
    expect(task.status).toBe("running");
    expect(d.findTask(leased?.task.id ?? "")?.status).toBe("running");
  });

  it("releaseTask returns the task to pending", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c } = manager.enqueueTask(taskInput("t1"), NOW);
    manager = c;
    const leased = manager.leaseTask(worker.id, NOW);
    manager = leased?.manager ?? manager;
    const { manager: d, task } = manager.releaseTask(leased?.task.id ?? "", worker.id, LATER);
    expect(task.status).toBe("pending");
    expect(d.pending.containsTask(task.id)).toBe(true);
    expect(d.find(worker.id)?.capacity.busy).toBe(0);
  });
});

describe("recovery / maintenance", () => {
  it("expireLeases recovers stale leases back to pending", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c } = manager.enqueueTask(taskInput("t1"), NOW);
    manager = c;
    const leased = manager.leaseTask(worker.id, NOW);
    manager = leased?.manager ?? manager;
    const taskId = leased?.task.id ?? "";
    const { manager: d, expired } = manager.expireLeases(LATER);
    expect(expired).toHaveLength(1);
    expect(d.findTask(taskId)?.status).toBe("pending");
    expect(d.pending.containsTask(taskId)).toBe(true);
    expect(d.find(worker.id)?.capacity.busy).toBe(0);
    const execution = d.listExecutions().find((entry) => entry.taskId === taskId);
    expect(execution?.status).toBe("cancelled");
  });

  it("cleanup prunes settled tasks older than retention", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c } = manager.enqueueTask(taskInput("old"), NOW);
    manager = c;
    const leased = manager.leaseTask(worker.id, NOW);
    manager = leased?.manager ?? manager;
    manager = manager.completeTask(leased?.task.id ?? "", worker.id, "2026-08-01T00:00:00.000Z").manager;
    const { manager: d, removed } = manager.cleanup(MUCH_LATER, 1000);
    expect(removed).toHaveLength(1);
    expect(d.hasTask(leased?.task.id ?? "")).toBe(false);
  });

  it("rebalance assigns pending tasks to idle workers", () => {
    let manager = new WorkerManager();
    const { manager: a, worker: w1 } = manager.registerWorker(makeWorker("alpha", { id: "w1" }));
    manager = a;
    const { manager: b, worker: w2 } = manager.registerWorker(makeWorker("beta", { id: "w2" }));
    manager = b;
    const { manager: c } = manager.startWorker(w1.id, NOW);
    manager = c;
    const { manager: d } = manager.startWorker(w2.id, NOW);
    manager = d;
    const { manager: e } = manager.enqueueTask(taskInput("t1"), NOW);
    manager = e;
    const { manager: f } = manager.enqueueTask(taskInput("t2"), NOW);
    manager = f;
    const { manager: g, assigned } = manager.rebalance(NOW);
    expect(assigned).toBe(2);
    expect(g.registry.listBusy()).toHaveLength(2);
  });

  it("scalePool adds and removes workers deterministically", () => {
    let manager = new WorkerManager();
    const { manager: a } = manager.registerWorker(makeWorker("alpha", { id: "w1", pool: "pool" }));
    manager = a;
    const { manager: b, added } = manager.scalePool("pool", 3, NOW);
    expect(added).toHaveLength(2);
    expect(b.registry.findByPool("pool")).toHaveLength(3);
    const { manager: c, removed } = b.scalePool("pool", 1, LATER);
    expect(removed).toHaveLength(2);
    expect(c.registry.findByPool("pool")).toHaveLength(1);
  });
});

describe("bulk operations", () => {
  it("bulkRegisters and bulkEnqueues atomically", () => {
    const manager = new WorkerManager();
    const { manager: a, workers } = manager.bulkRegisterWorkers([
      makeWorker("w1", { id: "w1" }),
      makeWorker("w2", { id: "w2" }),
    ]);
    expect(workers).toHaveLength(2);
    const { manager: b, tasks } = a.bulkEnqueueTasks([taskInput("t1"), taskInput("t2")], NOW);
    expect(tasks).toHaveLength(2);
    expect(b.countTasks()).toBe(2);
    const { manager: c, cancelled } = b.bulkCancelTasks([tasks[0]?.id ?? "", "missing"], LATER);
    expect(cancelled).toHaveLength(1);
    expect(c.findTask(tasks[0]?.id ?? "")?.status).toBe("cancelled");
  });
});

describe("statistics / snapshot / pools", () => {
  it("computes statistics over workers and tasks", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c } = manager.enqueueTask(taskInput("t1"), NOW);
    const stats = c.statistics();
    expect(stats.workers.active).toBe(1);
    expect(stats.tasks.pending).toBe(1);
  });

  it("builds a snapshot with pools", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.enqueueTask(taskInput("t1"), NOW);
    const snapshot = b.snapshot(NOW);
    expect(snapshot.workers).toHaveLength(1);
    expect(snapshot.pools[0]?.workerIds).toEqual([worker.id]);
    expect(snapshot.statistics.tasks.pending).toBe(1);
  });

  it("queueStatistics reports depth per queue", () => {
    const manager = new WorkerManager();
    const { manager: a } = manager.enqueueTask(taskInput("t1"), NOW);
    const { manager: b } = a.enqueueTask(taskInput("later", { scheduledAt: LATER }), NOW);
    const stats = b.queueStatistics(NOW);
    expect(stats.pending.total).toBe(1);
    expect(stats.delayed.total).toBe(1);
    expect(stats.retry.total).toBe(0);
  });
});

describe("retryDelayFor", () => {
  it("backs off exponentially and caps at maxDelayMs", () => {
    expect(retryDelayFor(1000, 1)).toBe(1000);
    expect(retryDelayFor(1000, 2)).toBe(2000);
    expect(retryDelayFor(1000, 3)).toBe(4000);
    expect(retryDelayFor(1000, 3, 2500)).toBe(2500);
  });
});

describe("immutability", () => {
  it("never mutates the receiver", () => {
    const manager = new WorkerManager();
    const { manager: a } = manager.enqueueTask(taskInput("t1"), NOW);
    expect(manager.countTasks()).toBe(0);
    expect(a.countTasks()).toBe(1);
    expect(manager.pending).toBe(manager.pending);
  });

  it("keeps configuration frozen", () => {
    const manager = new WorkerManager();
    expect(Object.isFrozen(manager.configuration)).toBe(true);
  });
});

describe("configuration", () => {
  it("applies configuration defaults to workers", () => {
    const config = createWorkerConfiguration({ capacity: { maxConcurrent: 4 }, leaseDurationMs: 5000 });
    const manager = new WorkerManager({ configuration: config });
    const { worker } = manager.registerWorker(makeWorker("alpha"));
    expect(worker.capacity.maxConcurrent).toBe(4);
    expect(worker.limits.leaseDurationMs).toBe(5000);
  });
});

describe("regressions (review fixes)", () => {
  it("freeSlot never resurrects a stopped worker", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c, task } = manager.enqueueTask(taskInput("t1"), NOW);
    manager = c;
    const leased = manager.leaseTask(worker.id, NOW);
    expect(leased).toBeDefined();
    const { manager: d } = leased!.manager.stopWorker(worker.id, NOW, "rebalance");
    // A late settlement frees the slot; the worker must stay stopped.
    const { manager: e } = d.completeTask(task.id, worker.id, NOW);
    expect(e.find(worker.id)?.status).toBe("stopped");
    expect(e.find(worker.id)?.state).toBe("stopped");
  });

  it("completeTask only settles an active lease", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c, task } = manager.enqueueTask(taskInput("t1"), NOW);
    manager = c;
    const leased = manager.leaseTask(worker.id, NOW);
    expect(leased).toBeDefined();
    const d = leased!.manager;
    // Release the lease first, then complete: the released lease must not
    // be overwritten to "completed".
    const { manager: e } = d.releaseTask(task.id, worker.id, NOW);
    const { manager: f } = e.completeTask(task.id, worker.id, NOW);
    const lease = f.listLeases().find((entry) => entry.taskId === task.id);
    expect(lease?.status).toBe("released");
  });

  it("expireLeases enqueues a single pending item per task", () => {
    const config = createWorkerConfiguration({ leaseDurationMs: 1 });
    let manager = new WorkerManager({ configuration: config });
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha"));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c, task } = manager.enqueueTask(taskInput("t1"), NOW);
    manager = c;
    const leased = manager.leaseTask(worker.id, NOW);
    expect(leased).toBeDefined();
    const d = leased!.manager;
    const { manager: e, expired } = d.expireLeases(LATER);
    expect(expired).toHaveLength(1);
    expect(e.pending.items.filter((item) => item.taskId === task.id)).toHaveLength(1);
  });
});
