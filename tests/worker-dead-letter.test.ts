import { describe, it, expect } from "vitest";
import {
  DeadLetterQueue,
  createDeadLetterEntry,
} from "@/lib/workers/deadLetter";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:10:00.000Z";
const MUCH_LATER = "2026-08-11T12:00:00.000Z";

function entry(taskId: string, failedAt = NOW, extra: Partial<Parameters<typeof createDeadLetterEntry>[0]> = {}) {
  return createDeadLetterEntry({
    taskId,
    attempts: 3,
    failedAt,
    error: { code: "handler_error", message: "boom" },
    ...extra,
  });
}

describe("createDeadLetterEntry", () => {
  it("derives deterministic ids and defaults", () => {
    const a = entry("t1");
    const b = entry("t1");
    expect(a.id).toBe(b.id);
    expect(a.replayable).toBe(true);
    expect(a.attempts).toBe(3);
  });

  it("freezes nested error", () => {
    const e = entry("t1");
    expect(Object.isFrozen(e.error)).toBe(true);
    expect(Object.isFrozen(e)).toBe(true);
  });
});

describe("DeadLetterQueue basics", () => {
  it("adds entries via successor pattern", () => {
    const queue = new DeadLetterQueue();
    const { queue: next } = queue.add(entry("t1"));
    expect(queue.count()).toBe(0);
    expect(next.count()).toBe(1);
    expect(next.hasTask("t1")).toBe(true);
  });

  it("rejects duplicate entries by id", () => {
    const queue = new DeadLetterQueue([entry("t1")]);
    expect(() => queue.add(entry("t2", NOW, { id: "dup" })).queue.add(entry("t3", NOW, { id: "dup" }))).toThrow();
  });

  it("removes by id and by task", () => {
    const queue = new DeadLetterQueue([entry("t1"), entry("t2")]);
    expect(queue.remove("missing")).toBe(queue);
    const removed = queue.removeTask("t1");
    expect(removed.hasTask("t1")).toBe(false);
    expect(removed.count()).toBe(1);
  });

  it("returns detached copies", () => {
    const queue = new DeadLetterQueue([entry("t1")]);
    const found = queue.find(queue.entries[0]?.id ?? "");
    expect(found).not.toBe(queue.entries[0]);
  });
});

describe("replay", () => {
  it("replays a single entry manually", () => {
    const queue = new DeadLetterQueue([entry("t1")]);
    const id = queue.entries[0]?.id ?? "";
    const { queue: next, entry: replayed } = queue.replay(id, LATER);
    expect(replayed.replayedAt).toBe(LATER);
    expect(replayed.replayResult).toBe("completed");
    expect(next.pendingReplayCount()).toBe(0);
    expect(queue.pendingReplayCount()).toBe(1);
  });

  it("throws for unknown replay ids", () => {
    const queue = new DeadLetterQueue();
    expect(() => queue.replay("nope", LATER)).toThrow();
  });

  it("replays all replayable entries automatically", () => {
    const queue = new DeadLetterQueue([
      entry("t1"),
      entry("t2", NOW, { replayable: false }),
      entry("t3"),
    ]);
    const { queue: next, entries } = queue.replayAll(LATER);
    expect(entries).toHaveLength(2);
    expect(next.pendingReplayCount()).toBe(0);
    expect(next.statistics().replayed).toBe(2);
  });

  it("skips already-replayed entries", () => {
    const queue = new DeadLetterQueue([entry("t1")]);
    const id = queue.entries[0]?.id ?? "";
    const { queue: replayed } = queue.replay(id, LATER);
    expect(replayed.replayAll(LATER).entries).toHaveLength(0);
  });
});

describe("expire / cleanup", () => {
  it("expires entries older than the retention window", () => {
    const queue = new DeadLetterQueue([entry("old", "2026-08-01T00:00:00.000Z"), entry("new", NOW)]);
    const { queue: next, entries } = queue.expire(NOW, 7 * 24 * 3600 * 1000);
    expect(entries.map((e) => e.taskId)).toEqual(["old"]);
    expect(next.count()).toBe(1);
  });

  it("expire is a no-op when nothing is expired", () => {
    const queue = new DeadLetterQueue([entry("t1", NOW)]);
    const result = queue.expire(NOW, 1000);
    expect(result.queue).toBe(queue);
    expect(result.entries).toEqual([]);
  });

  it("cleanup is an alias of expire", () => {
    const queue = new DeadLetterQueue([entry("t1", "2026-08-01T00:00:00.000Z")]);
    const { entries } = queue.cleanup(MUCH_LATER, 1000);
    expect(entries).toHaveLength(1);
  });
});

describe("statistics / list / snapshot / hash", () => {
  it("computes statistics", () => {
    const queue = new DeadLetterQueue([entry("t1"), entry("t2", NOW, { replayable: false })]);
    const id = queue.entries[0]?.id ?? "";
    const { queue: next } = queue.replay(id, LATER);
    const stats = next.statistics();
    expect(stats.total).toBe(2);
    expect(stats.replayable).toBe(0);
    expect(stats.replayed).toBe(1);
    expect(stats.failed).toBe(1);
  });

  it("lists entries oldest first", () => {
    const queue = new DeadLetterQueue([
      entry("late", LATER),
      entry("early", "2026-08-01T00:00:00.000Z"),
    ]);
    expect(queue.list().map((e) => e.taskId)).toEqual(["early", "late"]);
  });

  it("snapshots and hashes deterministically", () => {
    const queue = new DeadLetterQueue([entry("t1")]);
    expect(queue.hashQueue()).toBe(queue.hashQueue());
    const snapshot = queue.snapshot();
    expect(snapshot.entries).toHaveLength(1);
  });
});
