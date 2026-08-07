import { describe, it, expect } from "vitest";
import { ContextDeduplicator } from "@/lib/context/contextDeduplicator";
import type { RankedContext } from "@/lib/context/types";

/** Build a valid RankedContext fixture (defaults: no threadId, null timestamp). */
function makeRanked(overrides: Partial<RankedContext> = {}): RankedContext {
  return {
    id: "ctx-1",
    source: "gmail",
    title: "Title",
    content: "Content",
    timestamp: null,
    relevance: 0.5,
    tokenEstimate: 10,
    truncated: false,
    compressed: false,
    metadata: { kind: "email", entityId: "e1" },
    permissions: null,
    score: 0.5,
    ...overrides,
  };
}

const deduplicator = new ContextDeduplicator();

describe("ContextDeduplicator basics", () => {
  it("returns [] for empty input", () => {
    expect(deduplicator.deduplicate([])).toEqual([]);
  });

  it("passes a single item through (as a new object)", () => {
    const input = [makeRanked({ id: "only", score: 0.8 })];
    const result = deduplicator.deduplicate(input);
    expect(result).toHaveLength(1);
    expect(result[0]).not.toBe(input[0]);
    expect(result[0]!.id).toBe("only");
    expect(result[0]!.score).toBe(0.8);
  });

  it("keeps every item when there are no duplicates", () => {
    const input = [
      makeRanked({ id: "a", score: 0.3 }),
      makeRanked({ id: "b", score: 0.9 }),
      makeRanked({ id: "c", score: 0.6 }),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result.map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("leaves an already-unique input untouched in content", () => {
    const input = [makeRanked({ id: "x", content: "keep me" })];
    const result = deduplicator.deduplicate(input);
    expect(result[0]!.content).toBe("keep me");
  });
});

describe("ContextDeduplicator stage 1 — exact ids", () => {
  it("keeps only one item when ids are duplicated", () => {
    const input = [
      makeRanked({ id: "same", score: 0.5 }),
      makeRanked({ id: "same", score: 0.7 }),
    ];
    expect(deduplicator.deduplicate(input)).toHaveLength(1);
  });

  it("keeps the highest-scoring duplicate when it comes second", () => {
    const input = [
      makeRanked({ id: "same", score: 0.4, content: "first" }),
      makeRanked({ id: "same", score: 0.9, content: "second" }),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result[0]!.content).toBe("second");
  });

  it("keeps the highest-scoring duplicate when it comes first", () => {
    const input = [
      makeRanked({ id: "same", score: 0.9, content: "first" }),
      makeRanked({ id: "same", score: 0.4, content: "second" }),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result[0]!.content).toBe("first");
  });

  it("keeps the first item when scores are equal", () => {
    const input = [
      makeRanked({ id: "same", score: 0.5, content: "first" }),
      makeRanked({ id: "same", score: 0.5, content: "second" }),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result[0]!.content).toBe("first");
  });

  it("keeps the highest-scoring item in a duplicate chain", () => {
    const input = [
      makeRanked({ id: "chain", score: 0.3, content: "low" }),
      makeRanked({ id: "chain", score: 0.8, content: "high" }),
      makeRanked({ id: "chain", score: 0.5, content: "mid" }),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result[0]!.content).toBe("high");
  });

  it("keeps the first item in an equal-score duplicate chain", () => {
    const input = [
      makeRanked({ id: "chain", score: 0.6, content: "first" }),
      makeRanked({ id: "chain", score: 0.6, content: "second" }),
      makeRanked({ id: "chain", score: 0.6, content: "third" }),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result[0]!.content).toBe("first");
  });

  it("deduplicates by id even across different sources", () => {
    const input = [
      makeRanked({ id: "shared", source: "gmail", score: 0.4 }),
      makeRanked({ id: "shared", source: "github", score: 0.8, metadata: { kind: "issue", entityId: "1" } }),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("github");
  });
});

describe("ContextDeduplicator stage 2 — thread collapse", () => {
  function threadItem(id: string, score: number, threadId: string, ts: string | null): RankedContext {
    return makeRanked({ id, score, metadata: { kind: "email", entityId: id, threadId }, timestamp: ts });
  }

  it("collapses one thread to a single item", () => {
    const input = [
      threadItem("m1", 0.5, "t1", "2026-08-07T00:00:00.000Z"),
      threadItem("m2", 0.6, "t1", "2026-08-07T01:00:00.000Z"),
    ];
    expect(deduplicator.deduplicate(input)).toHaveLength(1);
  });

  it("keeps separate threads separate", () => {
    const input = [
      threadItem("m1", 0.5, "t1", "2026-08-07T00:00:00.000Z"),
      threadItem("m2", 0.6, "t1", "2026-08-07T01:00:00.000Z"),
      threadItem("m3", 0.9, "t2", "2026-08-07T02:00:00.000Z"),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result).toHaveLength(2);
  });

  it("does not collapse threads across different sources", () => {
    const input = [
      makeRanked({ id: "a", source: "gmail", score: 0.5, metadata: { kind: "email", entityId: "a", threadId: "t1" } }),
      makeRanked({ id: "b", source: "github", score: 0.6, metadata: { kind: "issue", entityId: "b", threadId: "t1" } }),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result).toHaveLength(2);
  });

  it("does not collapse items with a missing threadId even in the same source", () => {
    const input = [
      makeRanked({ id: "a", source: "gmail", score: 0.5, metadata: { kind: "email", entityId: "a" } }),
      makeRanked({ id: "b", source: "gmail", score: 0.6, metadata: { kind: "email", entityId: "b" } }),
    ];
    expect(deduplicator.deduplicate(input)).toHaveLength(2);
  });

  it("picks the highest-scoring thread member", () => {
    const input = [
      threadItem("m1", 0.4, "t1", "2026-08-07T00:00:00.000Z"),
      threadItem("m2", 0.9, "t1", "2026-08-07T01:00:00.000Z"),
      threadItem("m3", 0.7, "t1", "2026-08-07T02:00:00.000Z"),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result[0]!.id).toBe("m2");
  });

  it("picks the newest thread member on equal scores", () => {
    const input = [
      threadItem("older", 0.8, "t1", "2026-08-06T00:00:00.000Z"),
      threadItem("newer", 0.8, "t1", "2026-08-07T00:00:00.000Z"),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result[0]!.id).toBe("newer");
  });

  it("keeps the first thread member when scores and null timestamps tie", () => {
    const input = [
      threadItem("first", 0.5, "t1", null),
      threadItem("second", 0.5, "t1", null),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result[0]!.id).toBe("first");
  });

  it("prefers a real timestamp over a null one on equal scores", () => {
    const input = [
      threadItem("null-ts", 0.7, "t1", null),
      threadItem("dated", 0.7, "t1", "2026-08-07T00:00:00.000Z"),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result[0]!.id).toBe("dated");
  });

  it("keeps the first thread member on a full tie (equal score, equal timestamp)", () => {
    const input = [
      threadItem("first", 0.6, "t1", "2026-08-07T00:00:00.000Z"),
      threadItem("second", 0.6, "t1", "2026-08-07T00:00:00.000Z"),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result[0]!.id).toBe("first");
  });

  it("collapses multiple thread groups to one item each", () => {
    const input = [
      threadItem("t1a", 0.5, "t1", null),
      threadItem("t1b", 0.6, "t1", null),
      threadItem("t2a", 0.8, "t2", null),
      threadItem("t2b", 0.9, "t2", null),
      threadItem("t3", 0.4, "t3", null),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result).toHaveLength(3);
  });

  it("leaves a single-member thread untouched", () => {
    const input = [threadItem("solo", 0.5, "t1", null)];
    expect(deduplicator.deduplicate(input)).toHaveLength(1);
  });

  it("treats an empty-string threadId as a present thread key (edge case)", () => {
    const input = [
      makeRanked({ id: "a", score: 0.5, metadata: { kind: "email", entityId: "a", threadId: "" } }),
      makeRanked({ id: "b", score: 0.6, metadata: { kind: "email", entityId: "b", threadId: "" } }),
    ];
    expect(deduplicator.deduplicate(input)).toHaveLength(1);
  });

  it("treats unparseable timestamps as unknown on ties", () => {
    const input = [
      threadItem("invalid", 0.5, "t1", "not-a-date"),
      threadItem("null", 0.5, "t1", null),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result[0]!.id).toBe("invalid"); // both unknown → keep first
  });
});

describe("ContextDeduplicator stage ordering (exact then thread)", () => {
  it("runs exact-key dedupe before thread collapse", () => {
    // "same" appears twice with different threadIds; the higher scorer wins
    // stage 1, so the lower scorer's thread no longer exists for stage 2.
    const input = [
      makeRanked({ id: "same", source: "gmail", score: 0.9, metadata: { kind: "email", entityId: "a", threadId: "t1" } }),
      makeRanked({ id: "same", source: "gmail", score: 0.8, metadata: { kind: "email", entityId: "b", threadId: "t2" } }),
      makeRanked({ id: "other", source: "gmail", score: 0.7, metadata: { kind: "email", entityId: "c", threadId: "t1" } }),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("same");
  });

  it("feeds the stage-1 winner into thread selection", () => {
    const input = [
      makeRanked({ id: "x", source: "gmail", score: 0.6, timestamp: "2026-08-06T00:00:00.000Z", metadata: { kind: "email", entityId: "a", threadId: "t1" } }),
      makeRanked({ id: "x", source: "gmail", score: 0.5, timestamp: "2026-08-07T00:00:00.000Z", metadata: { kind: "email", entityId: "b", threadId: "t2" } }),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result).toHaveLength(1);
    // Stage 1 keeps the 0.6 item (thread t1), which then stands alone.
    expect(result[0]!.metadata.threadId).toBe("t1");
  });

  it("handles a mix of duplicate ids and threads", () => {
    const input = [
      makeRanked({ id: "a", source: "gmail", score: 0.5, metadata: { kind: "email", entityId: "a", threadId: "t1" } }),
      makeRanked({ id: "a", source: "gmail", score: 0.6, metadata: { kind: "email", entityId: "a2", threadId: "t1" } }),
      makeRanked({ id: "b", source: "gmail", score: 0.7, metadata: { kind: "email", entityId: "b", threadId: "t1" } }),
      makeRanked({ id: "c", source: "discord", score: 0.9, metadata: { kind: "message", entityId: "c" } }),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result.map((c) => c.id)).toEqual(["c", "b"]);
  });
});

describe("ContextDeduplicator ordering", () => {
  it("returns contexts sorted by score descending after dedupe", () => {
    const input = [
      makeRanked({ id: "a", score: 0.2 }),
      makeRanked({ id: "b", score: 0.9 }),
      makeRanked({ id: "b", score: 0.5 }),
      makeRanked({ id: "c", score: 0.6 }),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result.map((c) => c.id)).toEqual(["b", "c", "a"]);
    for (let i = 1; i < result.length; i += 1) {
      expect(result[i - 1]!.score).toBeGreaterThanOrEqual(result[i]!.score);
    }
  });

  it("is stable for equal scores after dedupe", () => {
    const input = [
      makeRanked({ id: "x", score: 0.5, content: "x-first" }),
      makeRanked({ id: "x", score: 0.5, content: "x-dup" }),
      makeRanked({ id: "y", score: 0.5, content: "y-first" }),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result.map((c) => c.content)).toEqual(["x-first", "y-first"]);
  });

  it("keeps one winner when everything ties (equal everything)", () => {
    const input = [
      makeRanked({ id: "same", score: 0.5, metadata: { kind: "email", entityId: "1", threadId: "t1" } }),
      makeRanked({ id: "same", score: 0.5, metadata: { kind: "email", entityId: "2", threadId: "t1" } }),
      makeRanked({ id: "same", score: 0.5, metadata: { kind: "email", entityId: "3", threadId: "t1" } }),
    ];
    const result = deduplicator.deduplicate(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.metadata.entityId).toBe("1");
  });
});

describe("ContextDeduplicator immutability and determinism", () => {
  it("never mutates the input array", () => {
    const input = [
      makeRanked({ id: "a", score: 0.9 }),
      makeRanked({ id: "a", score: 0.2 }),
      makeRanked({ id: "b", score: 0.5 }),
    ];
    const snapshot = input.map((c) => c.id);
    deduplicator.deduplicate(input);
    expect(input.map((c) => c.id)).toEqual(snapshot);
    expect(input).toHaveLength(3);
  });

  it("never mutates the input context objects", () => {
    const item = makeRanked({ id: "a", content: "original", score: 0.7 });
    deduplicator.deduplicate([item, makeRanked({ id: "b", score: 0.5 })]);
    expect(item.content).toBe("original");
    expect(item.score).toBe(0.7);
  });

  it("never mutates metadata objects", () => {
    const metadata = { kind: "email" as const, entityId: "e1", threadId: "t1" };
    const input = [
      makeRanked({ id: "a", score: 0.9, metadata }),
      makeRanked({ id: "b", score: 0.5, metadata: { kind: "email", entityId: "e2", threadId: "t1" } }),
    ];
    deduplicator.deduplicate(input);
    expect(metadata).toEqual({ kind: "email", entityId: "e1", threadId: "t1" });
  });

  it("returns new objects rather than input references", () => {
    const input = [makeRanked({ id: "a", score: 0.9 }), makeRanked({ id: "b", score: 0.5 })];
    const result = deduplicator.deduplicate(input);
    for (let i = 0; i < result.length; i += 1) {
      expect(result[i]).not.toBe(input[i]);
    }
  });

  it("is deterministic for identical inputs", () => {
    const input = [
      makeRanked({ id: "a", score: 0.5, metadata: { kind: "email", entityId: "a", threadId: "t1" } }),
      makeRanked({ id: "a", score: 0.7, metadata: { kind: "email", entityId: "a2", threadId: "t1" } }),
      makeRanked({ id: "b", score: 0.6 }),
    ];
    const first = deduplicator.deduplicate(input);
    const second = deduplicator.deduplicate(input);
    expect(first.map((c) => c.id)).toEqual(second.map((c) => c.id));
    expect(first.map((c) => c.score)).toEqual(second.map((c) => c.score));
  });
});

describe("ContextDeduplicator scale", () => {
  it("handles large inputs efficiently and correctly", () => {
    const input: RankedContext[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const baseScore = (i % 50) / 50;
      input.push(makeRanked({ id: `id-${i}`, score: baseScore, content: `item-${i}` }));
      // Duplicates with varying scores — some beat the first occurrence.
      input.push(makeRanked({ id: `id-${i}`, score: baseScore * 1.5, content: `dup-${i}` }));
    }
    const result = deduplicator.deduplicate(input);
    expect(result).toHaveLength(1000);
    const seen = new Set(result.map((c) => c.id));
    expect(seen.size).toBe(1000);
  });
});
