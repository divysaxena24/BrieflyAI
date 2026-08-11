/**
 * Phase 6D STEP 3 — notification queue tests.
 */
import { describe, expect, it } from "vitest";
import {
  NotificationQueue,
  createNotificationQueue,
  createNotificationQueueSet,
  orderNotificationQueueItems,
  notificationQueueIdFor,
  DEFAULT_NOTIFICATION_QUEUE_CAPACITY,
} from "@/lib/notifications/queue";
import { createNotificationQueueItem } from "@/lib/notifications/types";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:05:00.000Z";
const FUTURE = "2026-08-11T10:00:00.000Z";

const queue = (kind: "priority" | "fifo" | "delayed" | "retry" | "deadLetter") =>
  createNotificationQueue(kind, { createdAt: NOW });

const item = (notificationId: string, overrides: Record<string, unknown> = {}) =>
  createNotificationQueueItem({
    notificationId,
    enqueuedAt: NOW,
    priority: "normal",
    ...overrides,
  });

describe("NotificationQueue construction", () => {
  it("builds a queue with deterministic id and defaults", () => {
    const q = queue("priority");
    expect(q.kind).toBe("priority");
    expect(q.id).toBe(notificationQueueIdFor("priority", NOW));
    expect(q.name).toBe("priority");
    expect(q.capacity).toBe(DEFAULT_NOTIFICATION_QUEUE_CAPACITY);
    expect(q.count()).toBe(0);
    expect(Object.isFrozen(q.items)).toBe(true);
  });

  it("accepts an explicit id, name and capacity", () => {
    const q = new NotificationQueue("retry", { id: "r1", name: "retries", capacity: 5, createdAt: NOW });
    expect(q.id).toBe("r1");
    expect(q.name).toBe("retries");
    expect(q.capacity).toBe(5);
    expect(q.availableSlots()).toBe(5);
  });

  it("copies initial items and freezes the internal array", () => {
    const q = new NotificationQueue("priority", { createdAt: NOW }, [item("n1")]);
    expect(q.count()).toBe(1);
    expect(() => (q.items as NotificationQueueItem[]).push(item("x"))).toThrow();
  });
});

describe("enqueue / remove / replace / contains", () => {
  it("enqueue returns a successor queue without mutating the receiver", () => {
    const q = queue("priority");
    const { queue: next, item: stored } = q.enqueue(item("n1"));
    expect(q.count()).toBe(0);
    expect(next.count()).toBe(1);
    expect(stored.notificationId).toBe("n1");
  });

  it("rejects duplicate item ids", () => {
    const q = queue("priority");
    const { queue: next } = q.enqueue(item("n1"));
    expect(() => next.enqueue(item("n1"))).toThrow(/already contains/);
  });

  it("rejects enqueue at capacity", () => {
    const q = new NotificationQueue("priority", { createdAt: NOW, capacity: 1 });
    const { queue: next } = q.enqueue(item("n1"));
    expect(() => next.enqueue(item("n2"))).toThrow(/capacity/);
  });

  it("remove is a no-op for absent ids", () => {
    const q = queue("priority");
    expect(q.remove("missing")).toBe(q);
  });

  it("removeNotification drops every item of a notification", () => {
    let q = queue("priority");
    ({ queue: q } = q.enqueue(item("n1")));
    ({ queue: q } = q.enqueue(item("n2")));
    const next = q.removeNotification("n1");
    expect(next.count()).toBe(1);
    expect(next.findByNotification("n2")).toBeDefined();
  });

  it("replace swaps an existing item in place", () => {
    const q = queue("priority");
    const { queue: next } = q.enqueue(item("n1", { attempt: 0 }));
    const replaced = item("n1", { attempt: 3, status: "retrying" });
    const { queue: updated } = next.replace(replaced);
    expect(updated.findByNotification("n1")?.attempt).toBe(3);
  });

  it("replace throws for unknown item ids", () => {
    const q = queue("priority");
    expect(() => q.replace(item("n1"))).toThrow(/does not contain/);
  });

  it("contains / containsNotification answer accurately", () => {
    const { queue: q } = queue("priority").enqueue(item("n1", { id: "i1" }));
    expect(q.contains("i1")).toBe(true);
    expect(q.containsNotification("n1")).toBe(true);
    expect(q.contains("nope")).toBe(false);
  });
});

describe("ordering, peek and dequeue", () => {
  it("orders by priority descending then enqueue time then id", () => {
    const items = [
      item("low", { priority: "low", enqueuedAt: NOW }),
      item("high", { priority: "high", enqueuedAt: NOW }),
      item("normal", { priority: "normal", enqueuedAt: LATER }),
      item("normal-a", { priority: "normal", enqueuedAt: LATER }),
    ];
    const ordered = orderNotificationQueueItems(items).map((entry) => entry.notificationId);
    expect(ordered[0]).toBe("high");
    expect(ordered[ordered.length - 1]).toBe("low");
  });

  it("orders delayed items by dequeueAt ascending", () => {
    const q = queue("delayed");
    const a = item("a", { dequeueAt: FUTURE });
    const b = item("b", { dequeueAt: LATER });
    const { queue: next } = q.enqueue(a).queue.enqueue(b);
    expect(next.list().map((entry) => entry.notificationId)).toEqual(["b", "a"]);
  });

  it("peek returns the next due item without removing it", () => {
    const { queue: q } = queue("priority").enqueue(item("n1"));
    expect(q.peek(NOW)?.notificationId).toBe("n1");
    expect(q.count()).toBe(1);
  });

  it("peek returns undefined when nothing is due", () => {
    const { queue: q } = queue("delayed").enqueue(item("n1", { dequeueAt: FUTURE }));
    expect(q.peek(NOW)).toBeUndefined();
  });

  it("dequeue takes due items in deterministic order", () => {
    let q = queue("priority");
    ({ queue: q } = q.enqueue(item("n1", { priority: "low" })));
    ({ queue: q } = q.enqueue(item("n2", { priority: "critical" })));
    const { queue: next, items } = q.dequeue(2, NOW);
    expect(items.map((entry) => entry.notificationId)).toEqual(["n2", "n1"]);
    expect(next.count()).toBe(0);
  });

  it("dequeue respects the count limit", () => {
    let q = queue("priority");
    ({ queue: q } = q.enqueue(item("n1")));
    ({ queue: q } = q.enqueue(item("n2")));
    const { items } = q.dequeue(1, NOW);
    expect(items).toHaveLength(1);
  });

  it("batchDequeue is the batch alias of dequeue", () => {
    const { queue: q } = queue("priority").enqueue(item("n1"));
    const { items } = q.batchDequeue(1, NOW);
    expect(items).toHaveLength(1);
  });

  it("dequeue is a no-op when nothing is due", () => {
    const { queue: q } = queue("delayed").enqueue(item("n1", { dequeueAt: FUTURE }));
    const { items } = q.dequeue(5, NOW);
    expect(items).toHaveLength(0);
    expect(q.count()).toBe(1);
  });
});

describe("statistics, summary, snapshot, hash", () => {
  it("statistics report total/due/future/capacity", () => {
    const { queue: q } = queue("delayed")
      .enqueue(item("n1", { dequeueAt: FUTURE }))
      .queue.enqueue(item("n2", { dequeueAt: NOW }));
    const stats = q.statistics(NOW);
    expect(stats.total).toBe(2);
    expect(stats.due).toBe(1);
    expect(stats.future).toBe(1);
    expect(stats.available).toBe(DEFAULT_NOTIFICATION_QUEUE_CAPACITY - 2);
  });

  it("summary aggregates per-priority counts", () => {
    let q = queue("priority");
    ({ queue: q } = q.enqueue(item("n1", { priority: "high" })));
    ({ queue: q } = q.enqueue(item("n2", { priority: "low" })));
    const summary = q.summary();
    expect(summary.byPriority.high).toBe(1);
    expect(summary.byPriority.low).toBe(1);
    expect(summary.total).toBe(2);
  });

  it("snapshot freezes queue, items, statistics and summary", () => {
    const { queue: q } = queue("priority").enqueue(item("n1"));
    const snapshot = q.snapshot(LATER);
    expect(snapshot.at).toBe(LATER);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.queue.kind).toBe("priority");
    expect(snapshot.items).toHaveLength(1);
  });

  it("hashQueue is deterministic and content-sensitive", () => {
    const a = queue("priority").enqueue(item("n1")).queue;
    const b = queue("priority").enqueue(item("n1")).queue;
    expect(a.hashQueue()).toBe(b.hashQueue());
    const c = queue("priority").enqueue(item("n2")).queue;
    expect(a.hashQueue()).not.toBe(c.hashQueue());
  });
});

describe("NotificationQueueSet", () => {
  const set = () => createNotificationQueueSet({ createdAt: NOW });

  it("routes future-scheduled items into delayed", () => {
    const { set: next, item: stored } = set().enqueue({
      notificationId: "n1",
      enqueuedAt: NOW,
      dequeueAt: FUTURE,
    });
    expect(stored.kind).toBe("delayed");
    expect(next.delayed.count()).toBe(1);
    expect(next.pending.count()).toBe(0);
  });

  it("routes immediate items into pending", () => {
    const { set: next } = set().enqueue({ notificationId: "n1", enqueuedAt: NOW });
    expect(next.pending.count()).toBe(1);
  });

  it("promoteDue advances due delayed items into pending", () => {
    let s = set();
    ({ set: s } = s.enqueue({ notificationId: "n1", enqueuedAt: NOW, dequeueAt: LATER }));
    const { set: promoted, promoted: items } = s.promoteDue(LATER);
    expect(items).toHaveLength(1);
    expect(promoted.pending.count()).toBe(1);
    expect(promoted.delayed.count()).toBe(0);
  });

  it("promoteDue advances due retry items into pending", () => {
    let s = set();
    ({ set: s } = s.enqueue({ notificationId: "n1", enqueuedAt: NOW }));
    ({ set: s } = s.retryItem({
      notificationId: "n1",
      at: NOW,
      dequeueAt: LATER,
      attempt: 1,
    }));
    const { set: promoted, promoted: items } = s.promoteDue(LATER);
    expect(items).toHaveLength(1);
    expect(promoted.pending.count()).toBe(1);
    expect(promoted.retry.count()).toBe(0);
  });

  it("promoteDue does not promote items that are not yet due", () => {
    let s = set();
    ({ set: s } = s.enqueue({ notificationId: "n1", enqueuedAt: NOW, dequeueAt: FUTURE }));
    const { set: promoted, promoted: items } = s.promoteDue(LATER);
    expect(items).toHaveLength(0);
    expect(promoted.delayed.count()).toBe(1);
  });

  it("retryItem moves a queued item into the retry queue with dequeueAt", () => {
    let s = set();
    ({ set: s } = s.enqueue({ notificationId: "n1", enqueuedAt: NOW }));
    const { set: next, item: stored } = s.retryItem({
      notificationId: "n1",
      at: LATER,
      dequeueAt: FUTURE,
      attempt: 1,
    });
    expect(stored?.kind).toBe("retry");
    expect(next.retry.count()).toBe(1);
    expect(next.pending.count()).toBe(0);
  });

  it("deadLetterItem moves a queued item into the dead-letter queue", () => {
    let s = set();
    ({ set: s } = s.enqueue({ notificationId: "n1", enqueuedAt: NOW }));
    const { set: next, item: stored } = s.deadLetterItem({
      notificationId: "n1",
      at: LATER,
      attempt: 3,
    });
    expect(stored?.status).toBe("dead");
    expect(next.deadLetter.count()).toBe(1);
  });

  it("cancel removes a notification from every queue", () => {
    let s = set();
    ({ set: s } = s.enqueue({ notificationId: "n1", enqueuedAt: NOW }));
    const next = s.cancel("n1");
    expect(next.containsNotification("n1")).toBe(false);
  });

  it("containsNotification / queueOf locate items across queues", () => {
    let s = set();
    ({ set: s } = s.enqueue({ notificationId: "n1", enqueuedAt: NOW }));
    ({ set: s } = s.enqueue({ notificationId: "n2", enqueuedAt: NOW, dequeueAt: FUTURE }));
    expect(s.containsNotification("n1")).toBe(true);
    expect(s.queueOf("n2")?.kind).toBe("delayed");
    expect(s.containsNotification("missing")).toBe(false);
  });

  it("dequeue drains only pending items", () => {
    let s = set();
    ({ set: s } = s.enqueue({ notificationId: "n1", enqueuedAt: NOW, priority: "high" }));
    ({ set: s } = s.enqueue({ notificationId: "n2", enqueuedAt: NOW }));
    const { set: next, items } = s.dequeue(10, NOW);
    expect(items.map((entry) => entry.notificationId)).toEqual(["n1", "n2"]);
    expect(next.pending.count()).toBe(0);
  });

  it("aggregate statistics and summary span every queue", () => {
    let s = set();
    ({ set: s } = s.enqueue({ notificationId: "n1", enqueuedAt: NOW }));
    ({ set: s } = s.enqueue({ notificationId: "n2", enqueuedAt: NOW }));
    ({ set: s } = s.deadLetterItem({ notificationId: "n2", at: NOW, attempt: 1 }));
    const stats = s.statistics(NOW);
    expect(stats.total).toBe(2);
    expect(stats.pending.total).toBe(1);
    expect(stats.deadLetter.total).toBe(1);
    const summary = s.summary();
    expect(summary.total).toBe(2);
    expect(Object.isFrozen(summary)).toBe(true);
  });

  it("snapshot exposes every queue's state at `at`", () => {
    const s = set();
    const snapshot = s.snapshot(LATER);
    expect(snapshot.at).toBe(LATER);
    expect(snapshot.statistics.total).toBe(0);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("mutations are successor-based", () => {
    const original = set();
    const { set: next } = original.enqueue({ notificationId: "n1", enqueuedAt: NOW });
    expect(original.pending.count()).toBe(0);
    expect(next.pending.count()).toBe(1);
  });
});
