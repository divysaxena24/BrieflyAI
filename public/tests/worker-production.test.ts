import { describe, it, expect } from "vitest";
import {
  WorkerEngine,
  createProductionWorkerEngine,
  getProductionWorkerEngine,
  workerStatus,
} from "@/lib/workers/production";
import { WorkerTaskHandlerRegistry } from "@/lib/workers/executor";
import { JobManager } from "@/lib/jobs/manager";
import { JobRepository } from "@/lib/jobs/repository";
import { createJob } from "@/lib/jobs/types";
import { createProductionJobEngine } from "@/lib/jobs/production";
import { JobHandlerRegistry } from "@/lib/jobs/executor";
import { WorkerManager } from "@/lib/workers/manager";
import { WorkerRegistry } from "@/lib/workers/registry";
import {
  createWorker,
  createWorkerLease,
  createWorkerTask,
  touchWorker,
  touchWorkerTask,
} from "@/lib/workers/types";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:01:00.000Z";

function makeWorker(name: string, extra: Record<string, unknown> = {}) {
  return { name, pool: "main", createdAt: NOW, ...extra };
}

/** Build an engine with a custom handler for deterministic tests. */
function customEngine(handler: (taskId: string, now: string) => Promise<unknown> = async () => "ok") {
  const registry = new WorkerTaskHandlerRegistry().register("custom", async (context) =>
    handler(context.task.id, context.now),
  );
  return createProductionWorkerEngine({
    handlerRegistry: registry,
    now: () => NOW,
  });
}

describe("createProductionWorkerEngine", () => {
  it("wires built-in handlers over the production engines", () => {
    const engine = createProductionWorkerEngine({ now: () => NOW });
    expect(engine.executor).toBeDefined();
    expect(engine.scheduler).toBeDefined();
    expect(engine.supervisor).toBeDefined();
    expect(engine.jobEngine).toBeDefined();
    expect(engine.workflowEngine).toBeDefined();
    expect(engine.actionEngine).toBeDefined();
    expect(engine.digestEngine).toBeDefined();
    expect(engine.toolExecutor).toBeDefined();
    expect(engine.countWorkers()).toBe(0);
  });

  it("is pure at construction — nothing runs", () => {
    const engine = customEngine();
    expect(engine.countTasks()).toBe(0);
  });
});

describe("runOnce / runWorkers", () => {
  it("executes custom tasks end-to-end", async () => {
    const engine = customEngine();
    const { engine: e1 } = engine.registerWorker(makeWorker("alpha", { id: "w1" }));
    const { engine: e2 } = e1.startWorker("w1", NOW);
    const { engine: e3 } = e2.enqueueTask(
      createWorkerTask({ name: "t1", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW }),
      NOW,
    );
    const summary = await e3.runOnce(NOW);
    expect(summary.leased).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(e3.findTask(e3.listTasks()[0]?.id ?? "")?.status).toBe("completed");
  });

  it("settles failures without stopping other tasks (failure isolation)", async () => {
    const engine = customEngine(async (taskId) => {
      if (taskId.includes("bad")) throw new Error("boom");
      return "ok";
    });
    const { engine: e1 } = engine.registerWorker(makeWorker("alpha", { id: "w1" }));
    const { engine: e2 } = e1.registerWorker(makeWorker("beta", { id: "w2" }));
    const { engine: e3 } = e2.startWorker("w1", NOW);
    const { engine: e4 } = e3.startWorker("w2", NOW);
    const { engine: e5 } = e4.enqueueTask(
      createWorkerTask({ name: "bad", id: "bad", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW }),
      NOW,
    );
    const { engine: e6 } = e5.enqueueTask(
      createWorkerTask({ name: "good", id: "good", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW }),
      NOW,
    );
    const summary = await e6.runOnce(NOW);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(e6.findTask("bad")?.status).toBe("dead");
    expect(e6.findTask("good")?.status).toBe("completed");
  });

  it("leases to every idle worker up to capacity", async () => {
    const engine = customEngine();
    const { engine: e1 } = engine.registerWorker(makeWorker("a", { id: "w1" }));
    const { engine: e2 } = e1.registerWorker(makeWorker("b", { id: "w2" }));
    const { engine: e3 } = e2.startWorker("w1", NOW);
    const { engine: e4 } = e3.startWorker("w2", NOW);
    const { engine: e5 } = e4.enqueueTask(
      createWorkerTask({ name: "t1", id: "t1", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW }),
      NOW,
    );
    const { engine: e6 } = e5.enqueueTask(
      createWorkerTask({ name: "t2", id: "t2", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW }),
      NOW,
    );
    const summary = await e6.runOnce(NOW);
    expect(summary.leased).toBe(2);
    expect(summary.completed).toBe(2);
  });

  it("recovers stale leases during a run pass", async () => {
    const seededWorker = touchWorker(createWorker({ name: "alpha", pool: "main", createdAt: NOW, id: "w1" }), {
      status: "running",
      lastHeartbeatAt: NOW,
      updatedAt: NOW,
    });
    const seededTask = touchWorkerTask(
      createWorkerTask({ name: "stuck", id: "stuck", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW }),
      { status: "leased", attempts: 1 },
    );
    const staleLease = createWorkerLease({
      taskId: "stuck",
      workerId: "w1",
      acquiredAt: "2026-08-11T08:00:00.000Z",
      expiresAt: "2026-08-11T08:00:30.000Z",
    });
    const manager = new WorkerManager({
      registry: new WorkerRegistry([seededWorker]),
      tasks: [seededTask],
      leases: [staleLease],
    });
    const registry = new WorkerTaskHandlerRegistry().register("custom", async () => "recovered");
    const engine = createProductionWorkerEngine({ manager, handlerRegistry: registry, now: () => NOW });
    const summary = await engine.runOnce(NOW);
    expect(summary.expired).toBe(1);
    expect(engine.findTask("stuck")?.status).toBe("completed");
  });

  it("is deterministic for identical inputs", async () => {
    const run = async (): Promise<number> => {
      const engine = customEngine();
      const { engine: e1 } = engine.registerWorker(makeWorker("alpha", { id: "w1" }));
      const { engine: e2 } = e1.startWorker("w1", NOW);
      const { engine: e3 } = e2.enqueueTask(
        createWorkerTask({ name: "t1", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW }),
        NOW,
      );
      const summary = await e3.runOnce(NOW);
      return summary.completed;
    };
    expect(await run()).toBe(await run());
  });
});

describe("automatic retry across runs", () => {
  it("retries through the retry queue and dead-letters exhausted attempts", async () => {
    const engine = customEngine(async () => {
      throw new Error("always fails");
    });
    const { engine: e1 } = engine.registerWorker(makeWorker("alpha", { id: "w1" }));
    const { engine: e2 } = e1.startWorker("w1", NOW);
    const { engine: e3 } = e2.enqueueTask(
      createWorkerTask({
        name: "flaky",
        id: "flaky",
        kind: "custom",
        payload: { kind: "custom", input: {} },
        createdAt: NOW,
        maxAttempts: 2,
        retryPolicy: { maxRetries: 1, backoffMs: 0 },
      }),
      NOW,
    );
    const first = await e3.runOnce(NOW);
    expect(first.failed).toBe(1);
    expect(e3.findTask("flaky")?.status).toBe("retrying");
    const second = await e3.runOnce(NOW);
    expect(second.failed).toBe(1);
    expect(e3.findTask("flaky")?.status).toBe("dead");
    expect(e3.manager.deadLetter.hasTask("flaky")).toBe(true);
  });
});

describe("built-in handlers", () => {
  it("runs job tasks through the Job Engine", async () => {
    const manager = new JobManager(
      new JobRepository().add(
        createJob({ id: "manual-job", name: "manual", trigger: "manual", createdAt: NOW }),
      ).repository,
    );
    const handlers = new JobHandlerRegistry().register("manual-job", async () => ({ done: true }));
    const jobEngine = createProductionJobEngine({
      manager,
      handlerRegistry: handlers,
      seedDigestJob: false,
      now: () => NOW,
    });
    const engine = createProductionWorkerEngine({
      jobEngine,
      now: () => NOW,
    });
    const { engine: e1 } = engine.registerWorker(makeWorker("alpha", { id: "w1" }));
    const { engine: e2 } = e1.startWorker("w1", NOW);
    const { engine: e3 } = e2.enqueueTask(
      createWorkerTask({ name: "job-task", id: "jt", kind: "job", payload: { kind: "job", jobId: "manual-job" }, createdAt: NOW }),
      NOW,
    );
    const summary = await e3.runOnce(NOW);
    expect(summary.completed).toBe(1);
    const task = e3.findTask("jt");
    expect(task?.status).toBe("completed");
  });

  it("no-ops job tasks for unknown jobs (runManual semantics)", async () => {
    const jobEngine = createProductionJobEngine({ seedDigestJob: false, now: () => NOW });
    const engine = createProductionWorkerEngine({ jobEngine, now: () => NOW });
    const { engine: e1 } = engine.registerWorker(makeWorker("alpha", { id: "w1" }));
    const { engine: e2 } = e1.startWorker("w1", NOW);
    const { engine: e3 } = e2.enqueueTask(
      createWorkerTask({ name: "job-task", id: "jt", kind: "job", payload: { kind: "job", jobId: "nope" }, createdAt: NOW }),
      NOW,
    );
    const summary = await e3.runOnce(NOW);
    expect(summary.completed).toBe(1);
    expect(e3.findTask("jt")?.status).toBe("completed");
  });

  it("fails workflow tasks structurally for unknown workflows", async () => {
    const engine = createProductionWorkerEngine({ now: () => NOW });
    const { engine: e1 } = engine.registerWorker(makeWorker("alpha", { id: "w1" }));
    const { engine: e2 } = e1.startWorker("w1", NOW);
    const { engine: e3 } = e2.enqueueTask(
      createWorkerTask({ name: "workflow-task", id: "wt", kind: "workflow", payload: { kind: "workflow", workflowId: "missing-wf" }, createdAt: NOW }),
      NOW,
    );
    const summary = await e3.runOnce(NOW);
    expect(summary.failed).toBe(1);
    expect(e3.findTask("wt")?.error?.message).toContain("Workflow not found");
  });

  it("fails digest tasks for unknown templates", async () => {
    const engine = createProductionWorkerEngine({ now: () => NOW });
    const { engine: e1 } = engine.registerWorker(makeWorker("alpha", { id: "w1" }));
    const { engine: e2 } = e1.startWorker("w1", NOW);
    const { engine: e3 } = e2.enqueueTask(
      createWorkerTask({ name: "digest-task", id: "dt", kind: "digest", payload: { kind: "digest", template: "unknown-template", userId: "u1" }, createdAt: NOW }),
      NOW,
    );
    const summary = await e3.runOnce(NOW);
    expect(summary.failed).toBe(1);
    expect(e3.findTask("dt")?.error?.message).toContain("Unknown digest template");
  });

  it("fails tool tasks for invalid plans", async () => {
    const engine = createProductionWorkerEngine({ now: () => NOW });
    const { engine: e1 } = engine.registerWorker(makeWorker("alpha", { id: "w1" }));
    const { engine: e2 } = e1.startWorker("w1", NOW);
    const { engine: e3 } = e2.enqueueTask(
      createWorkerTask({
        name: "tool-task",
        id: "tt",
        kind: "tool",
        payload: { kind: "tool", planId: "plan-1", steps: "not-an-array" },
        createdAt: NOW,
      }),
      NOW,
    );
    const summary = await e3.runOnce(NOW);
    expect(summary.failed).toBe(1);
  });
});

describe("shutdown / restart / status", () => {
  it("shuts down and restarts workers", () => {
    const engine = customEngine();
    const { engine: e1 } = engine.registerWorker(makeWorker("alpha", { id: "w1" }));
    const { engine: e2 } = e1.registerWorker(makeWorker("beta", { id: "w2" }));
    const { engine: e3 } = e2.startWorker("w1", NOW);
    const { engine: e4 } = e3.startWorker("w2", NOW);
    const { summary: shutdown, engine: e5 } = e4.shutdownWorkers(NOW, "test");
    expect(shutdown.stoppedCount).toBe(2);
    expect(e5.listWorkers().every((w) => w.status === "stopped")).toBe(true);
    const { summary: restart, engine: e6 } = e5.restartWorkers(LATER);
    expect(restart.restartedCount).toBe(2);
    expect(e6.listWorkers().every((w) => w.status === "running")).toBe(true);
  });

  it("reports worker health status", () => {
    const engine = customEngine();
    const { engine: e1 } = engine.registerWorker(makeWorker("alpha", { id: "w1" }));
    const { engine: e2 } = e1.startWorker("w1", NOW);
    const { engine: e3 } = e2.heartbeat("w1", NOW);
    const health = e3.workerStatus(NOW);
    expect(health.reports).toHaveLength(1);
    expect(health.aggregate.total).toBe(1);
  });
});

describe("production singleton", () => {
  it("returns the single application instance", () => {
    expect(getProductionWorkerEngine()).toBe(getProductionWorkerEngine());
    expect(workerStatus()).toBeDefined();
  });
});

describe("scalePool via engine", () => {
  it("scales pools through the engine", () => {
    const engine = customEngine();
    const { engine: e1, added } = engine.scalePool("main", 3, NOW);
    expect(added).toHaveLength(3);
    expect(e1.countWorkers()).toBe(3);
  });
});

describe("WorkerEngine class", () => {
  it("is constructible directly with dependency injection", () => {
    const engine = new WorkerEngine({ now: () => NOW });
    expect(engine).toBeInstanceOf(WorkerEngine);
  });
});
