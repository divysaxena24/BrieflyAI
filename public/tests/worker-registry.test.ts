import { describe, it, expect } from "vitest";
import {
  WorkerRegistry,
  WorkerDuplicateError,
  WorkerNotFoundError,
} from "@/lib/workers/registry";
import { createWorker, touchWorker } from "@/lib/workers/types";

const NOW = "2026-08-11T09:00:00.000Z";

function worker(name: string, extra: Parameters<typeof createWorker>[0] = {}) {
  return createWorker({ name, pool: "main", createdAt: NOW, ...extra });
}

describe("register / replace / update / remove", () => {
  it("registers workers via successor pattern", () => {
    const registry = new WorkerRegistry();
    const { registry: next, worker: stored } = registry.register(worker("alpha"));
    expect(registry.count()).toBe(0);
    expect(next.count()).toBe(1);
    expect(next.has(stored.id)).toBe(true);
  });

  it("rejects duplicate registrations", () => {
    const registry = new WorkerRegistry([worker("alpha", { id: "w1" })]);
    expect(() => registry.register(worker("beta", { id: "w1" }))).toThrow(WorkerDuplicateError);
  });

  it("replaces by id", () => {
    const registry = new WorkerRegistry([worker("alpha", { id: "w1" })]);
    const { registry: next } = registry.replace(worker("renamed", { id: "w1" }));
    expect(next.find("w1")?.name).toBe("renamed");
    expect(next.count()).toBe(1);
  });

  it("rejects replace/remove/update for unknown ids", () => {
    const registry = new WorkerRegistry();
    expect(() => registry.replace(worker("x"))).toThrow(WorkerNotFoundError);
    expect(() => registry.remove("nope")).toThrow(WorkerNotFoundError);
    expect(() => registry.update("nope", { updatedAt: NOW })).toThrow(WorkerNotFoundError);
  });

  it("updates workers immutably", () => {
    const registry = new WorkerRegistry([worker("alpha", { id: "w1" })]);
    const { registry: next, worker: updated } = registry.update("w1", {
      status: "running",
      state: "running",
      lastHeartbeatAt: NOW,
      updatedAt: NOW,
    });
    expect(registry.find("w1")?.status).toBe("registered");
    expect(updated.status).toBe("running");
    expect(next.find("w1")?.status).toBe("running");
  });

  it("clears everything", () => {
    const registry = new WorkerRegistry([worker("alpha"), worker("beta")]);
    expect(registry.clear().count()).toBe(0);
  });
});

describe("reads", () => {
  const busy = touchWorker(worker("busy-one", { id: "w1" }), {
    status: "busy",
    state: "busy",
    capacity: { busy: 1 },
    updatedAt: NOW,
  });
  const idle = touchWorker(worker("idle-one", { id: "w2" }), { status: "idle", updatedAt: NOW });
  const stale = touchWorker(worker("stale-one", { id: "w3" }), {
    status: "idle",
    lastHeartbeatAt: "2026-08-11T07:00:00.000Z",
    updatedAt: NOW,
  });
  const registry = new WorkerRegistry([busy, idle, stale]);

  it("lists detached clones in registration order", () => {
    const list = registry.list();
    expect(list.map((w) => w.id)).toEqual(["w1", "w2", "w3"]);
    expect(list[0]).not.toBe(busy);
  });

  it("finds healthy, busy, and idle workers", () => {
    expect(registry.listHealthy(NOW).map((w) => w.id)).toEqual(["w1", "w2"]);
    expect(registry.listBusy().map((w) => w.id)).toEqual(["w1"]);
    expect(registry.listIdle(NOW).map((w) => w.id)).toEqual(["w2"]);
  });

  it("finds by capability, pool, status, priority", () => {
    const gmail = worker("gmail-worker", {
      id: "w4",
      capabilities: ["gmail", "calendar"],
    });
    const plain = worker("plain-worker", { id: "w5", pool: "other" });
    const critical = worker("crit", { id: "w6", priority: "critical" });
    const withThese = new WorkerRegistry([gmail, plain, critical]);
    expect(withThese.findByCapability(["gmail", "calendar"]).map((w) => w.id)).toEqual(["w4"]);
    expect(withThese.findByPool("other").map((w) => w.id)).toEqual(["w5"]);
    expect(withThese.findByStatus(["registered"]).map((w) => w.id)).toEqual(["w4", "w5", "w6"]);
    expect(withThese.findByPriority(["critical"]).map((w) => w.id)).toEqual(["w6"]);
  });

  it("computes capacity", () => {
    const big = touchWorker(
      createWorker({ name: "big", pool: "main", capacity: { maxConcurrent: 4, weight: 2 }, createdAt: NOW, id: "w7" }),
      { status: "idle", updatedAt: NOW },
    );
    const reg = new WorkerRegistry([busy, idle, stale, big]);
    expect(reg.totalCapacity()).toBe(1 + 1 + 1 + 8);
    expect(reg.busySlots()).toBe(1);
    expect(reg.availableCapacity(NOW)).toBe(1 + 4);
  });

  it("computes statistics", () => {
    const stats = registry.statistics();
    expect(stats.workers.busy).toBe(1);
    expect(stats.workers.idle).toBe(2);
    expect(stats.workers.registered).toBe(0);
  });

  it("builds summaries", () => {
    const summaries = registry.summaries();
    expect(summaries).toHaveLength(3);
    expect(summaries[0]?.id).toBe("w1");
  });
});

describe("immutability", () => {
  it("never aliases stored workers", () => {
    const registry = new WorkerRegistry([worker("alpha", { id: "w1" })]);
    const found = registry.find("w1");
    expect(found).not.toBe(registry.workers[0]);
    expect(Object.isFrozen(registry.workers[0])).toBe(true);
  });
});
