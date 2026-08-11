import { describe, it, expect } from "vitest";
import {
  WorkerIntegration,
  createProductionWorkerIntegration,
  managerFromSnapshot,
  snapshotAt,
  wireWorkerEvents,
} from "@/lib/workers/background";
import { createProductionWorkerEngine } from "@/lib/workers/production";
import { WorkerTaskHandlerRegistry } from "@/lib/workers/executor";
import { createProductionDatabase } from "@/lib/database/production";
import { createProductionEventBus } from "@/lib/events/production";
import { eventBuilders } from "@/lib/events/types";
import { WorkerManager } from "@/lib/workers/manager";
import { createWorkerTask } from "@/lib/workers/types";

const NOW = "2026-08-11T09:00:00.000Z";

function makeWorker(name: string, extra: Record<string, unknown> = {}) {
  return { name, pool: "main", createdAt: NOW, ...extra };
}

function customEngine() {
  const registry = new WorkerTaskHandlerRegistry().register("custom", async () => "ok");
  return createProductionWorkerEngine({ handlerRegistry: registry, now: () => NOW });
}

describe("managerFromSnapshot", () => {
  it("reconstructs queues from task statuses", () => {
    const manager = new WorkerManager();
    const tasks = [
      createWorkerTask({ name: "due", id: "due", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW }),
      createWorkerTask({ name: "later", id: "later", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW, scheduledAt: "2026-08-11T10:00:00.000Z" }),
    ];
    const snapshot = {
      at: NOW,
      workers: [],
      tasks,
      pools: [],
      leases: [],
      statistics: manager.statistics(),
    };
    const rebuilt = managerFromSnapshot(snapshot);
    expect(rebuilt.pending.containsTask("due")).toBe(true);
    expect(rebuilt.delayed.containsTask("later")).toBe(true);
    expect(rebuilt.findTask("due")?.status).toBe("pending");
  });
});

describe("WorkerIntegration persistence round-trip", () => {
  it("persists the manager snapshot through the database engine", async () => {
    const engine = customEngine();
    const database = createProductionDatabase();
    const integration = new WorkerIntegration({ engine, database, scope: "worker-test", now: () => NOW });
    const { engine: e1 } = engine.registerWorker(makeWorker("alpha", { id: "w1" }));
    const { engine: e2 } = e1.startWorker("w1", NOW);
    e2.enqueueTask(
      createWorkerTask({ name: "t1", id: "t1", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW }),
      NOW,
    );
    const { summary } = await integration.run(NOW);
    expect(summary.completed).toBe(1);
    await integration.persist(NOW);
    const repo = database.scoped("worker-test", "metadata");
    const record = await repo.find("workers");
    expect(record).toBeDefined();
  });

  it("recovers a fresh engine from the persisted snapshot", async () => {
    const engine = customEngine();
    const database = createProductionDatabase();
    const integration = new WorkerIntegration({ engine, database, scope: "worker-test", now: () => NOW });
    const { engine: e1 } = engine.registerWorker(makeWorker("alpha", { id: "w1" }));
    const { engine: e2 } = e1.startWorker("w1", NOW);
    e2.enqueueTask(
      createWorkerTask({ name: "t1", id: "t1", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW }),
      NOW,
    );
    await integration.run(NOW);
    await integration.persist(NOW);

    // Simulate a restart: a brand-new integration over the same database.
    const restarted = new WorkerIntegration({ engine: customEngine(), database, scope: "worker-test", now: () => NOW });
    const { engine: recovered, recovered: wasRecovered } = await restarted.recover();
    expect(wasRecovered).toBe(true);
    expect(recovered.countWorkers()).toBe(1);
    expect(recovered.countTasks()).toBe(1);
    expect(recovered.findTask("t1")?.status).toBe("completed");
  });

  it("recover is a no-op when nothing is persisted", async () => {
    const engine = customEngine();
    const database = createProductionDatabase();
    const integration = new WorkerIntegration({ engine, database, scope: "empty", now: () => NOW });
    const { engine: recovered, recovered: wasRecovered } = await integration.recover();
    expect(wasRecovered).toBe(false);
    expect(recovered).toBe(engine);
  });
});

describe("event bridge", () => {
  it("enqueues mapped tasks when the bus fires", async () => {
    const engine = customEngine();
    const bus = createProductionEventBus();
    const integration = createProductionWorkerIntegration({
      engine,
      bus,
      now: () => NOW,
      mapEventToTask: (event) => {
        if (event.type !== "job.completed") return undefined;
        return {
          name: `react-${event.entityId}`,
          kind: "custom",
          payload: { kind: "custom", input: { jobId: event.entityId } },
          createdAt: event.now,
        };
      },
    });
    expect(integration.isConnected()).toBe(true);
    await integration.currentBus()?.emit(eventBuilders.jobCompleted("job-1", NOW));
    expect(engine.countTasks()).toBe(1);
  });

  it("isolates mapping failures", async () => {
    const engine = customEngine();
    const bus = createProductionEventBus();
    const integration = createProductionWorkerIntegration({
      engine,
      bus,
      now: () => NOW,
      mapEventToTask: () => {
        throw new Error("mapping failed");
      },
    });
    const summary = await integration.currentBus()?.emit(eventBuilders.jobCompleted("job-1", NOW));
    expect(summary?.delivered).toBe(1);
    expect(engine.countTasks()).toBe(0);
  });

  it("wireWorkerEvents returns a connected bridge", () => {
    const engine = customEngine();
    const bus = createProductionEventBus();
    const { connected } = wireWorkerEvents(bus, engine);
    expect(connected).toBe(true);
  });
});

describe("shutdown / restart delegation", () => {
  it("shuts down and restarts through the integration", () => {
    const recoveredEngine = customEngine();
    const integration = new WorkerIntegration({ engine: recoveredEngine, now: () => NOW });
    const { engine: e1 } = recoveredEngine.registerWorker(makeWorker("alpha", { id: "w1" }));
    e1.startWorker("w1", NOW);
    const { summary: shutdown } = integration.shutdown(NOW, "graceful");
    expect(shutdown.stoppedCount).toBe(1);
    const { summary: restart } = integration.restart(NOW);
    expect(restart.restartedCount).toBe(1);
  });
});

describe("snapshotAt", () => {
  it("captures deterministic snapshots", () => {
    const engine = customEngine();
    const { engine: e1 } = engine.registerWorker(makeWorker("alpha", { id: "w1" }));
    const { engine: e2 } = e1.startWorker("w1", NOW);
    const snapshot = snapshotAt(e2, NOW);
    expect(snapshot.workers).toHaveLength(1);
    expect(snapshot.at).toBe(NOW);
    const rebuilt = managerFromSnapshot(snapshot);
    expect(rebuilt.countWorkers()).toBe(1);
    expect(rebuilt.listWorkers()[0]?.status).toBe("running");
  });
});
