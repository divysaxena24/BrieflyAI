import { describe, it, expect } from "vitest";
import {
  WorkerSupervisor,
  detectDeadWorkers,
  aggregateHealth,
  createWorkerSupervisor,
  createWorkerRecoveryRecord,
} from "@/lib/workers/supervisor";
import { WorkerManager } from "@/lib/workers/manager";
import { WorkerRegistry } from "@/lib/workers/registry";
import { createWorker, touchWorker } from "@/lib/workers/types";

const NOW = "2026-08-11T09:00:00.000Z";
const STALE = "2026-08-11T08:00:00.000Z";

function makeWorker(name: string, extra: Record<string, unknown> = {}) {
  return { name, pool: "main", createdAt: NOW, ...extra };
}

describe("detectDeadWorkers", () => {
  it("detects stale-heartbeat workers", () => {
    const manager = new WorkerManager();
    const { manager: a, worker: w1 } = manager.registerWorker(makeWorker("fresh"));
    const { manager: b } = a.startWorker(w1.id, NOW);
    const { manager: c } = b.heartbeat(w1.id, NOW);
    const { manager: d, worker: stale } = c.registerWorker(makeWorker("stale"));
    const { manager: e } = d.startWorker(stale.id, STALE);
    const { manager: f } = e.heartbeat(stale.id, STALE);
    const dead = detectDeadWorkers(f.listWorkers(), NOW);
    expect(dead.map((w) => w.id)).toEqual([stale.id]);
  });

  it("treats heartbeat-less workers as alive", () => {
    const manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("fresh"));
    expect(detectDeadWorkers(a.listWorkers(), NOW).map((w) => w.id)).not.toContain(worker.id);
  });
});

describe("aggregateHealth", () => {
  it("counts healthy, stale, and unknown workers", () => {
    const manager = new WorkerManager();
    const { manager: a, worker: beat } = manager.registerWorker(makeWorker("beat", { id: "w1" }));
    const { manager: b } = a.startWorker(beat.id, NOW);
    const { manager: c } = b.heartbeat(beat.id, NOW);
    const { manager: d, worker: stale } = c.registerWorker(makeWorker("stale", { id: "w2" }));
    const { manager: e } = d.startWorker(stale.id, STALE);
    const { manager: f } = e.heartbeat(stale.id, STALE);
    const { manager: g } = f.registerWorker(makeWorker("never", { id: "w3" }));
    const health = aggregateHealth(g.listWorkers(), NOW);
    expect(health.total).toBe(3);
    expect(health.healthy).toBe(1);
    expect(health.unhealthy).toBe(1);
    expect(health.unknown).toBe(1);
  });
});

describe("WorkerSupervisor.supervise", () => {
  it("restarts dead workers below the restart limit", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha", { id: "w1" }));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, STALE);
    manager = b;
    const { manager: c } = manager.heartbeat(worker.id, STALE);
    manager = c;
    const supervisor = createWorkerSupervisor({ maxRestarts: 3 });
    const { manager: d, report } = supervisor.supervise(manager, NOW);
    expect(report.dead).toEqual([worker.id]);
    expect(report.restarted).toHaveLength(1);
    expect(report.escalated).toHaveLength(0);
    expect(d.find(worker.id)?.status).toBe("running");
    expect(d.find(worker.id)?.restartCount).toBe(1);
  });

  it("escalates workers past the restart limit", () => {
    const seeded = touchWorker(createWorker({ name: "alpha", pool: "main", createdAt: NOW, id: "w1" }), {
      restartCount: 3,
      status: "running",
      lastHeartbeatAt: STALE,
      updatedAt: STALE,
    });
    const manager = new WorkerManager({ registry: new WorkerRegistry([seeded]) });
    const supervisor = new WorkerSupervisor({ maxRestarts: 3 });
    const { manager: d, report } = supervisor.supervise(manager, NOW);
    expect(report.restarted).toHaveLength(0);
    expect(report.escalated).toHaveLength(1);
    expect(d.find("w1")?.status).toBe("stopped");
  });

  it("is a no-op when every worker is healthy", () => {
    let manager = new WorkerManager();
    const { manager: a, worker } = manager.registerWorker(makeWorker("alpha", { id: "w1" }));
    manager = a;
    const { manager: b } = manager.startWorker(worker.id, NOW);
    manager = b;
    const { manager: c } = manager.heartbeat(worker.id, NOW);
    manager = c;
    const supervisor = new WorkerSupervisor();
    const { manager: d, report } = supervisor.supervise(manager, NOW);
    expect(report.dead).toEqual([]);
    expect(report.restarted).toEqual([]);
    expect(report.escalated).toEqual([]);
    expect(d).toBe(manager);
  });

  it("reports recovered workers when failures reset", () => {
    const seeded = touchWorker(createWorker({ name: "alpha", pool: "main", createdAt: NOW, id: "w1" }), {
      failures: 2,
      status: "running",
      lastHeartbeatAt: NOW,
      health: { status: "healthy", score: 1, lastHeartbeatAt: NOW },
      updatedAt: NOW,
    });
    const manager = new WorkerManager({ registry: new WorkerRegistry([seeded]) });
    const supervisor = new WorkerSupervisor();
    const { report } = supervisor.supervise(manager, NOW);
    expect(report.recovered).toHaveLength(1);
    expect(report.health.healthy).toBe(1);
  });
});

describe("createWorkerRecoveryRecord", () => {
  it("builds deterministic recovery records", () => {
    const record = createWorkerRecoveryRecord("w1", NOW, 1, "restarted");
    expect(record.workerId).toBe("w1");
    expect(record.restartCount).toBe(1);
    expect(record.action).toBe("restarted");
    expect(record.id.startsWith("recovery-")).toBe(true);
  });
});
