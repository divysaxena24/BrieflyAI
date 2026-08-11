import { describe, it, expect } from "vitest";
import {
  WorkerQueue,
  createWorkerQueue,
  createQueueItem,
  orderQueueItems,
  queueIdFor,
  DEFAULT_QUEUE_CAPACITY,
} from "@/lib/workers/queue";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:01:00.000Z";
const MUCH_LATER = "2026-08-11T09:02:00.000Z";

function item(taskId: string, enqueuedAt = NOW, extra: Partial<Parameters<typeof createQueueItem>[0]> = {}) {
  return createQueueItem({ taskId, enqueuedAt, ...extra });
}

describe("createQueueItem", () => {
  it("derives deterministic ids and defaults", () => {
    const a = item("t1");
    const b = item("t1");
    expect(a.id).toBe(b.id);
    expect(a.priority).toBe("normal");
    expect(a.status).toBe("pending");
    expect(a.attempt).toBe(0);
  });

  it("honors explicit overrides", () => {
    const i = item("t1", NOW, { priority: "critical", dequeueAt: LATER, attempt: 2 });
    expect(i.priority).toBe("critical");
    expect(i.dequeueAt).toBe(LATER);
    expect(i.attempt).toBe(2);
  });
});

describe("WorkerQueue basics", () => {
  it("starts empty with defaults", () => {
    const queue = createWorkerQueue("priority", { createdAt: NOW });
    expect(queue.count()).toBe(0);
    expect(queue.isFull()).toBe(false);
    expect(queue.availableSlots()).toBe(DEFAULT_QUEUE_CAPACITY);
    expect(queue.id).toBe(queueIdFor("priority", NOW));
    expect(queue.name).toBe("priority");
  });

  it("enqueue returns a successor queue without mutating the receiver", () => {
    const queue = createWorkerQueue("priority", { createdAt: NOW });
    const { queue: next, item: stored } = queue.enqueue(item("t1"));
    expect(queue.count()).toBe(0);
    expect(next.count()).toBe(1);
    expect(next.contains(stored.id)).toBe(true);
    expect(next.containsTask("t1")).toBe(true);
  });

  it("rejects duplicate items", () => {
    const queue = createWorkerQueue("priority", { createdAt: NOW });
    const first = queue.enqueue(item("t1"));
    expect(() => first.queue.enqueue(item("t1"))).toThrow();
  });

  it("rejects over-capacity enqueues", () => {
    const queue = new WorkerQueue("priority", { createdAt: NOW, capacity: 1 });
    const first = queue.enqueue(item("t1"));
    expect(() => first.queue.enqueue(item("t2"))).toThrow(/capacity/);
  });

  it("remove is a no-op for absent ids", () => {
    const queue = createWorkerQueue("priority", { createdAt: NOW });
    expect(queue.remove("nope")).toBe(queue);
  });

  it("replace swaps items and throws for unknown ids", () => {
    const queue = createWorkerQueue("priority", { createdAt: NOW });
    const { queue: next, item: stored } = queue.enqueue(item("t1", NOW, { priority: "low" }));
    const { queue: replaced } = next.replace({ ...stored, priority: "high" });
    expect(replaced.find(stored.id)?.priority).toBe("high");
    expect(() => queue.replace(item("missing"))).toThrow();
  });

  it("returns detached copies on find", () => {
    const queue = createWorkerQueue("priority", { createdAt: NOW });
    const { queue: next, item: stored } = queue.enqueue(item("t1"));
    const found = next.find(stored.id);
    expect(found).not.toBe(stored);
  });
});

describe("dequeue ordering", () => {
  it("orders by priority descending", () => {
    const queue = createWorkerQueue("priority", { createdAt: NOW });
    const a = queue.enqueue(item("low", NOW, { priority: "low", id: "i-low" }));
    const b = a.queue.enqueue(item("crit", NOW, { priority: "critical", id: "i-crit" }));
    const c = b.queue.enqueue(item("high", NOW, { priority: "high", id: "i-high" }));
    const { items } = c.queue.dequeue(3, NOW);
    expect(items.map((i) => i.taskId)).toEqual(["crit", "high", "low"]);
  });

  it("breaks priority ties by due time then enqueue time then id", () => {
    const queue = createWorkerQueue("priority", { createdAt: NOW });
    const a = queue.enqueue(item("early", NOW, { dequeueAt: LATER, id: "i-b" }));
    const b = a.queue.enqueue(item("late", LATER, { id: "i-a" }));
    const { items } = b.queue.dequeue(2, LATER);
    expect(items.map((i) => i.taskId)).toEqual(["early", "late"]);
  });

  it("fifo kind dequeues in enqueue order", () => {
    const queue = createWorkerQueue("fifo", { createdAt: NOW });
    const a = queue.enqueue(item("t1", NOW));
    const b = a.queue.enqueue(item("t2", LATER));
    const c = b.queue.enqueue(item("t3", "2026-08-11T09:02:00.000Z"));
    const { items } = c.queue.dequeue(3, "2026-08-11T09:02:00.000Z");
    expect(items.map((i) => i.taskId)).toEqual(["t1", "t2", "t3"]);
  });

  it("batchDequeue takes only due items and keeps the rest", () => {
    const queue = createWorkerQueue("delayed", { createdAt: NOW });
    const a = queue.enqueue(item("future", NOW, { dequeueAt: MUCH_LATER }));
    const b = a.queue.enqueue(item("now1", NOW));
    const c = b.queue.enqueue(item("now2", LATER));
    const { queue: next, items } = c.queue.batchDequeue(10, LATER);
    expect(items.map((i) => i.taskId)).toEqual(["now1", "now2"]);
    expect(next.count()).toBe(1);
    expect(next.containsTask("future")).toBe(true);
  });

  it("honors the batch limit", () => {
    const queue = createWorkerQueue("priority", { createdAt: NOW });
    const a = queue.enqueue(item("t1"));
    const b = a.queue.enqueue(item("t2"));
    const { items } = b.queue.dequeue(1, NOW);
    expect(items).toHaveLength(1);
  });

  it("peek returns the next due item without removing", () => {
    const queue = createWorkerQueue("priority", { createdAt: NOW });
    const a = queue.enqueue(item("low", NOW, { priority: "low" }));
    const b = a.queue.enqueue(item("high", NOW, { priority: "high" }));
    expect(b.queue.peek(NOW)?.taskId).toBe("high");
    expect(b.queue.count()).toBe(2);
  });
});

describe("orderQueueItems", () => {
  it("is pure and deterministic", () => {
    const items = [item("b"), item("a")];
    const first = orderQueueItems(items);
    const second = orderQueueItems(items);
    expect(first.map((i) => i.taskId)).toEqual(second.map((i) => i.taskId));
    expect(items).toHaveLength(2);
  });
});

describe("statistics / model / hash", () => {
  it("computes queue statistics at an injected time", () => {
    const queue = createWorkerQueue("delayed", { createdAt: NOW });
    const a = queue.enqueue(item("future", NOW, { dequeueAt: LATER }));
    const b = a.queue.enqueue(item("now1", NOW));
    const stats = b.queue.statistics(NOW);
    expect(stats.total).toBe(2);
    expect(stats.due).toBe(1);
    expect(stats.future).toBe(1);
    expect(stats.capacity).toBe(DEFAULT_QUEUE_CAPACITY);
  });

  it("exposes an immutable queue model snapshot", () => {
    const queue = createWorkerQueue("priority", { createdAt: NOW });
    const { queue: next } = queue.enqueue(item("t1"));
    const model = next.model();
    expect(model.kind).toBe("priority");
    expect(model.itemIds).toHaveLength(1);
    expect(Object.isFrozen(model)).toBe(true);
  });

  it("hashes deterministically and changes with contents", () => {
    const queue = createWorkerQueue("priority", { createdAt: NOW });
    const a = queue.enqueue(item("t1"));
    const b = a.queue.enqueue(item("t2"));
    expect(a.queue.hashQueue()).toBe(a.queue.hashQueue());
    expect(a.queue.hashQueue()).not.toBe(b.queue.hashQueue());
  });
});

describe("immutability", () => {
  it("never exposes mutable state", () => {
    const queue = createWorkerQueue("priority", { createdAt: NOW });
    const { queue: next, item: stored } = queue.enqueue(item("t1"));
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(next.items)).toBe(true);
    const listed = next.list();
    expect(Object.isFrozen(listed[0])).toBe(true);
  });
});
