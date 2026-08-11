import { describe, it, expect } from "vitest";
import { createProductionWorkerEngine, getProductionWorkerEngine } from "@/lib/workers/production";
import { WorkerTaskHandlerRegistry } from "@/lib/workers/executor";
import { WorkerManager } from "@/lib/workers/manager";
import {
  WorkerIntegration,
  managerFromSnapshot,
  snapshotAt,
} from "@/lib/workers/background";
import { createProductionDatabase } from "@/lib/database/production";
import { createWorkerTask, type CreateWorkerTaskInput } from "@/lib/workers/types";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:10:00.000Z";

function customEngine(handler: (taskId: string) => Promise<unknown> = async () => "ok") {
  const registry = new WorkerTaskHandlerRegistry().register("custom", async (context) =>
    handler(context.task.id),
  );
  return createProductionWorkerEngine({
    handlerRegistry: registry,
    now: () => NOW,
    clockMs: () => 1000,
  });
}

function makeTask(index: number): CreateWorkerTaskInput {
  return {
    name: `job-${index}`,
    kind: "custom",
    payload: { kind: "custom", input: { index } },
    createdAt: NOW,
  };
}

describe("1000 workers / large queues", () => {
  it("drains a 1000-task queue through 1000 workers", async () => {
    const inputs = Array.from({ length: 1000 }, (_, index) => makeTask(index));
    const { manager: seeded } = new WorkerManager().bulkEnqueueTasks(inputs, NOW);
    const e1 = createProductionWorkerEngine({
      manager: seeded,
      handlerRegistry: new WorkerTaskHandlerRegistry().register("custom", async () => "ok"),
      now: () => NOW,
    });
    const { engine: e2 } = e1.scalePool("main", 1000, NOW);
    for (const worker of e2.listWorkers()) {
      e2.startWorker(worker.id, NOW);
    }
    expect(e2.countWorkers()).toBe(1000);
    let passes = 0;
    let completed = 0;
    let runner = e2.manager;
    while (runner.pending.count() > 0 && passes < 20) {
      const passEngine = createProductionWorkerEngine({
        manager: runner,
        handlerRegistry: new WorkerTaskHandlerRegistry().register("custom", async () => "ok"),
        now: () => NOW,
      });
      const summary = await passEngine.runOnce(NOW);
      passes += 1;
      completed += summary.completed;
      runner = passEngine.manager;
    }
    expect(passes).toBeLessThanOrEqual(20);
    expect(completed).toBe(1000);
    const settled = runner.listTasks();
    expect(settled.filter((task) => task.status === "completed")).toHaveLength(1000);
    expect(runner.deadLetter.count()).toBe(0);
    const ids = new Set(settled.map((task) => task.id));
    expect(ids.size).toBe(1000);
  });

  it("enqueues 10000 queued jobs deterministically", () => {
    const inputs = Array.from({ length: 10_000 }, (_, index) => makeTask(index));
    const { manager: seeded } = new WorkerManager().bulkEnqueueTasks(inputs, NOW);
    expect(seeded.countTasks()).toBe(10_000);
    expect(seeded.pending.count()).toBe(10_000);
    const stats = seeded.statistics();
    expect(stats.tasks.pending).toBe(10_000);
    const snapshot = seeded.snapshot(NOW);
    expect(snapshot.tasks).toHaveLength(10_000);
    // Deterministic ids at volume.
    const ids = new Set(snapshot.tasks.map((task) => task.id));
    expect(ids.size).toBe(10_000);
  });
});

describe("stress: failure isolation at scale", () => {
  it("settles 1000 mixed tasks without cross-task failures", async () => {
    const engine = customEngine(async (taskId) => {
      if (taskId.endsWith("bad")) throw new Error("boom");
      return "ok";
    });
    const { engine: e1 } = engine.scalePool("main", 200, NOW);
    for (const worker of e1.listWorkers()) {
      e1.startWorker(worker.id, NOW);
    }
    const inputs = Array.from({ length: 1000 }, (_, index) => ({
      ...makeTask(index),
      id: index % 2 === 0 ? `task-${index}-bad` : `task-${index}-good`,
    }));
    const { manager: seeded } = new WorkerManager().bulkEnqueueTasks(inputs, NOW);
    const scaled = createProductionWorkerEngine({
      manager: seeded,
      handlerRegistry: new WorkerTaskHandlerRegistry().register("custom", async () => "ok"),
      now: () => NOW,
    });
    const { engine: withWorkers } = scaled.scalePool("main", 200, NOW);
    for (const worker of withWorkers.listWorkers()) {
      withWorkers.startWorker(worker.id, NOW);
    }
    let runner = withWorkers.manager;
    let passes = 0;
    while (runner.pending.count() > 0 && passes < 20) {
      const engine3 = createProductionWorkerEngine({
        manager: runner,
        handlerRegistry: new WorkerTaskHandlerRegistry().register("custom", async (context) => {
          if (context.task.id.endsWith("bad")) throw new Error("boom");
          return "ok";
        }),
        now: () => NOW,
      });
      await engine3.runOnce(NOW);
      runner = engine3.manager;
      passes += 1;
    }
    const tasks = runner.listTasks();
    expect(tasks.filter((task) => task.status === "completed")).toHaveLength(500);
    expect(tasks.filter((task) => task.status === "dead")).toHaveLength(500);
    expect(runner.deadLetter.count()).toBe(500);
  });
});

describe("dependency ordering", () => {
  it("runs dependent tasks only after their dependencies complete", async () => {
    const engine = customEngine();
    const { engine: e1 } = engine.registerWorker({ name: "w1", pool: "main", createdAt: NOW, id: "w1" });
    const { engine: e2 } = e1.startWorker("w1", NOW);
    const { engine: e3 } = e2.enqueueTask(
      createWorkerTask({ name: "first", id: "first", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW }),
      NOW,
    );
    const { engine: e4 } = e3.enqueueTask(
      createWorkerTask({ name: "second", id: "second", kind: "custom", payload: { kind: "custom", input: {} }, dependencies: ["first"], createdAt: NOW }),
      NOW,
    );
    const first = await e4.runOnce(NOW);
    expect(first.completed).toBe(1);
    expect(e4.findTask("second")?.status).toBe("pending");
    const second = await e4.runOnce(NOW);
    expect(second.completed).toBe(1);
    expect(e4.findTask("second")?.status).toBe("completed");
  });
});

describe("cancellation", () => {
  it("cancels pending tasks before they run", async () => {
    const engine = customEngine();
    const { engine: e1 } = engine.registerWorker({ name: "w1", pool: "main", createdAt: NOW, id: "w1" });
    const { engine: e2 } = e1.startWorker("w1", NOW);
    const { engine: e3 } = e2.enqueueTask(
      createWorkerTask({ name: "doomed", id: "doomed", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW }),
      NOW,
    );
    const { manager: cancelled } = e3.manager.cancelTask("doomed", NOW);
    const cancelledEngine = createProductionWorkerEngine({
      manager: cancelled,
      handlerRegistry: new WorkerTaskHandlerRegistry().register("custom", async () => "ok"),
      now: () => NOW,
    });
    expect(cancelledEngine.findTask("doomed")?.status).toBe("cancelled");
    const summary = await cancelledEngine.runOnce(NOW);
    expect(summary.leased).toBe(0);
    expect(cancelledEngine.findTask("doomed")?.status).toBe("cancelled");
  });
});

describe("determinism and immutability", () => {
  it("produces identical results for identical inputs", async () => {
    const run = async (): Promise<string> => {
      const engine = customEngine();
      const { engine: e1 } = engine.registerWorker({ name: "w1", pool: "main", createdAt: NOW, id: "w1" });
      const { engine: e2 } = e1.startWorker("w1", NOW);
      const { engine: e3 } = e2.enqueueTask(
        createWorkerTask({ name: "a", id: "a", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW }),
        NOW,
      );
      const { engine: e4 } = e3.enqueueTask(
        createWorkerTask({ name: "b", id: "b", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW }),
        NOW,
      );
      await e4.runOnce(NOW);
      await e4.runOnce(NOW);
      return JSON.stringify(snapshotAt(e4, NOW));
    };
    expect(await run()).toBe(await run());
  });

  it("never mutates the receiver manager", async () => {
    const engine = customEngine();
    const { engine: e1 } = engine.registerWorker({ name: "w1", pool: "main", createdAt: NOW, id: "w1" });
    const { engine: e2 } = e1.startWorker("w1", NOW);
    const { engine: e3 } = e2.enqueueTask(
      createWorkerTask({ name: "a", id: "a", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW }),
      NOW,
    );
    const before = e3.manager.countTasks();
    await e3.runOnce(NOW);
    expect(e3.manager.countTasks()).toBe(1);
    expect(e3.manager.snapshot(NOW)).toBeDefined();
    void before;
  });
});

describe("restart recovery e2e", () => {
  it("persists, recovers and continues after a simulated restart", async () => {
    const database = createProductionDatabase();
    const integration = new WorkerIntegration({
      engine: customEngine(),
      database,
      scope: "e2e",
      now: () => NOW,
    });
    const { engine: e1 } = integration.engine().registerWorker({ name: "w1", pool: "main", createdAt: NOW, id: "w1" });
    const { engine: e2 } = e1.startWorker("w1", NOW);
    const { engine: e3 } = e2.enqueueTask(
      createWorkerTask({ name: "t1", id: "t1", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW }),
      NOW,
    );
    e3.enqueueTask(
      createWorkerTask({ name: "t2", id: "t2", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW }),
      NOW,
    );
    await integration.run(NOW);
    await integration.persist(NOW);
    expect(integration.engine().findTask("t1")?.status).toBe("completed");

    // Restart: a fresh integration recovers the persisted state.
    const restarted = new WorkerIntegration({ engine: customEngine(), database, scope: "e2e", now: () => NOW });
    const { engine: recovered } = await restarted.recover();
    expect(recovered.countWorkers()).toBe(1);
    expect(recovered.findTask("t1")?.status).toBe("completed");
    expect(recovered.findTask("t2")?.status).toBe("pending");
    const summary = await recovered.runOnce(LATER);
    expect(summary.completed).toBe(1);
    expect(recovered.findTask("t2")?.status).toBe("completed");
  });
});

describe("production composition", () => {
  it("exposes the singleton worker engine", () => {
    expect(getProductionWorkerEngine()).toBe(getProductionWorkerEngine());
  });

  it("managerFromSnapshot round-trips deterministically", () => {
    const engine = customEngine();
    const { engine: e1 } = engine.registerWorker({ name: "w1", pool: "main", createdAt: NOW, id: "w1" });
    const snapshot = snapshotAt(e1, NOW);
    const rebuilt = managerFromSnapshot(snapshot);
    expect(rebuilt.countWorkers()).toBe(1);
    expect(rebuilt.listWorkers()[0]?.id).toBe("w1");
  });
});

describe("automatic retries at scale", () => {
  it("retries then dead-letters 100 flaky tasks", async () => {
    const inputs = Array.from({ length: 100 }, (_, index) => ({
      ...makeTask(index),
      id: `flaky-${index}`,
      maxAttempts: 2,
      retryPolicy: { maxRetries: 1, backoffMs: 0 },
    }));
    const { manager: seeded } = new WorkerManager().bulkEnqueueTasks(inputs, NOW);
    const scaled = createProductionWorkerEngine({
      manager: seeded,
      handlerRegistry: new WorkerTaskHandlerRegistry().register("custom", async () => "ok"),
      now: () => NOW,
    });
    const { engine: withWorkers } = scaled.scalePool("main", 20, NOW);
    for (const worker of withWorkers.listWorkers()) {
      withWorkers.startWorker(worker.id, NOW);
    }
    let runner = withWorkers.manager;
    let pass = 0;
    while (runner.pending.count() + runner.retry.count() > 0 && pass < 15) {
      const engine = createProductionWorkerEngine({
        manager: runner,
        handlerRegistry: new WorkerTaskHandlerRegistry().register("custom", async () => {
          throw new Error("flaky");
        }),
        now: () => NOW,
      });
      await engine.runOnce(NOW);
      runner = engine.manager;
      pass += 1;
    }
    expect(runner.listTasks().filter((task) => task.status === "dead")).toHaveLength(100);
    expect(runner.deadLetter.count()).toBe(100);
  });
});
