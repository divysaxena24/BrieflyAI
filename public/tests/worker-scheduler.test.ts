import { describe, it, expect } from "vitest";
import {
  WorkerScheduler,
  dependenciesSatisfied,
  unsatisfiedDependencyCount,
  isItemDue,
  orderCandidates,
  selectNextItem,
  selectBatchItems,
  buildBatches,
  scheduleTaskReference,
  taskGroup,
} from "@/lib/workers/scheduler";
import { createQueueItem } from "@/lib/workers/queue";
import { createWorkerTask, touchWorkerTask, type WorkerTask } from "@/lib/workers/types";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:01:00.000Z";

function task(name: string, extra: Partial<Parameters<typeof createWorkerTask>[0]> = {}): WorkerTask {
  return createWorkerTask({
    name,
    kind: "custom",
    payload: { kind: "custom", input: {} },
    createdAt: NOW,
    ...extra,
  });
}

function item(taskId: string, priority: "low" | "normal" | "high" | "critical" = "normal", enqueuedAt = NOW) {
  return createQueueItem({ taskId, priority, enqueuedAt });
}

describe("dependenciesSatisfied", () => {
  const a = task("a", { id: "a" });
  const b = task("b", { id: "b", dependencies: ["a"] });
  const c = task("c", { id: "c", dependencies: ["missing"] });

  it("accepts dependency-free tasks", () => {
    expect(dependenciesSatisfied(a, [a, b])).toBe(true);
  });

  it("rejects unsatisfied and missing dependencies", () => {
    expect(dependenciesSatisfied(b, [a, b])).toBe(false);
    expect(dependenciesSatisfied(c, [a, b, c])).toBe(false);
  });

  it("accepts completed or cancelled dependencies", () => {
    const done = touchWorkerTask(task("a", { id: "a" }), { status: "completed" });
    const cancelled = touchWorkerTask(task("a2", { id: "a2" }), { status: "cancelled" });
    const dependent = task("d", { id: "d", dependencies: ["a", "a2"] });
    expect(dependenciesSatisfied(dependent, [done, cancelled, dependent])).toBe(true);
  });

  it("counts unsatisfied dependencies", () => {
    expect(unsatisfiedDependencyCount(b, [a, b])).toBe(1);
    expect(unsatisfiedDependencyCount(a, [a])).toBe(0);
  });
});

describe("isItemDue", () => {
  it("is due without a dequeueAt and when dequeueAt passes", () => {
    expect(isItemDue(item("t1"), NOW)).toBe(true);
    const delayed = createQueueItem({ taskId: "t1", enqueuedAt: NOW, dequeueAt: LATER });
    expect(isItemDue(delayed, NOW)).toBe(false);
    expect(isItemDue(delayed, LATER)).toBe(true);
  });
});

describe("orderCandidates", () => {
  it("orders by priority for the priority strategy", () => {
    const tasks = [task("low", { id: "low", priority: "low" }), task("crit", { id: "crit", priority: "critical" })];
    const items = [item("low", "low"), item("crit", "critical")];
    expect(orderCandidates(items, tasks, "priority").map((i) => i.taskId)).toEqual(["crit", "low"]);
  });

  it("round-robins groups for the fair strategy", () => {
    const tasks = [
      task("alpha-a", { id: "a1" }),
      task("alpha-b", { id: "a2" }),
      task("beta-x", { id: "b1" }),
      task("beta-y", { id: "b2" }),
    ];
    const items = [item("a1"), item("a2"), item("b1"), item("b2")];
    const ordered = orderCandidates(items, tasks, "fair").map((i) => i.taskId);
    // Groups alternate; the same group never appears twice consecutively.
    const groups = ordered.map((id) => taskGroup(tasks.find((t) => t.id === id) as WorkerTask));
    for (let index = 1; index < groups.length; index += 1) {
      expect(groups[index]).not.toBe(groups[index - 1]);
    }
  });

  it("weights by task priority for the weighted strategy", () => {
    const tasks = [task("low", { id: "low", priority: "low" }), task("crit", { id: "crit", priority: "critical" })];
    const items = [item("low", "low"), item("crit", "critical")];
    expect(orderCandidates(items, tasks, "weighted").map((i) => i.taskId)).toEqual(["crit", "low"]);
  });
});

describe("selectNextItem / selectBatchItems", () => {
  it("selects the next due dependency-ready item", () => {
    const tasks = [task("dep", { id: "dep", dependencies: ["missing"] }), task("ready", { id: "ready" })];
    const items = [item("dep"), item("ready")];
    expect(selectNextItem(items, tasks, NOW)?.taskId).toBe("ready");
  });

  it("selects nothing when every item is blocked", () => {
    const tasks = [task("dep", { id: "dep", dependencies: ["missing"] })];
    expect(selectNextItem([item("dep")], tasks, NOW)).toBeUndefined();
  });

  it("selects nothing when nothing is due", () => {
    const tasks = [task("t1", { id: "t1" })];
    const delayed = createQueueItem({ taskId: "t1", enqueuedAt: NOW, dequeueAt: LATER });
    expect(selectNextItem([delayed], tasks, NOW)).toBeUndefined();
  });

  it("can ignore dependencies when configured", () => {
    const tasks = [task("dep", { id: "dep", dependencies: ["missing"] })];
    const selected = selectNextItem([item("dep")], tasks, NOW, { requireDependencies: false });
    expect(selected?.taskId).toBe("dep");
  });

  it("selects batches deterministically", () => {
    const tasks = [task("a", { id: "a" }), task("b", { id: "b" }), task("c", { id: "c" })];
    const items = [item("a"), item("b"), item("c")];
    const batch = selectBatchItems(items, tasks, NOW, 2);
    const rest = selectBatchItems(items, tasks, NOW, 10);
    expect(rest).toHaveLength(3);
    // The batch is a deterministic prefix of the full selection.
    expect(batch).toEqual(rest.slice(0, 2));
  });
});

describe("buildBatches", () => {
  it("chunks task ids deterministically", () => {
    const batches = buildBatches(["a", "b", "c", "d", "e"], 2, NOW);
    expect(batches.map((b) => b.taskIds)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(batches[0]?.id.startsWith("batch-")).toBe(true);
  });
});

describe("scheduleTaskReference", () => {
  it("computes due timestamps with delay", () => {
    const immediate = scheduleTaskReference({
      referenceId: "j1",
      kind: "job",
      createdAt: NOW,
      now: NOW,
    });
    expect(immediate.dequeueAt).toBe(NOW);
    expect(immediate.scheduledAt).toBeUndefined();
    const delayed = scheduleTaskReference({
      referenceId: "j1",
      kind: "job",
      delayMs: 60_000,
      createdAt: NOW,
      now: NOW,
    });
    expect(delayed.dequeueAt).toBe(LATER);
    expect(delayed.scheduledAt).toBe(LATER);
  });
});

describe("WorkerScheduler", () => {
  it("selects the next item with the configured strategy", () => {
    const scheduler = new WorkerScheduler({ strategy: "priority" });
    const tasks = [task("crit", { id: "crit", priority: "critical" }), task("low", { id: "low", priority: "low" })];
    const items = [item("crit", "critical"), item("low", "low")];
    expect(scheduler.next(items, tasks, NOW)?.taskId).toBe("crit");
  });

  it("selects batches of the configured size", () => {
    const scheduler = new WorkerScheduler({ batchSize: 2 });
    const tasks = [task("a", { id: "a" }), task("b", { id: "b" }), task("c", { id: "c" })];
    const items = [item("a"), item("b"), item("c")];
    expect(scheduler.nextBatch(items, tasks, NOW)).toHaveLength(2);
    expect(scheduler.batches(["a", "b", "c"], NOW)).toHaveLength(2);
  });
});
