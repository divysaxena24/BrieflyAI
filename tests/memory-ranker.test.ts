import { describe, it, expect } from "vitest";
import {
  rankMemories,
  MEMORY_RANKING_WEIGHTS,
  MEMORY_KIND_WEIGHTS,
  MEMORY_SOURCE_WEIGHTS,
  CONVERSATION_RELEVANCE_BOOST,
} from "@/lib/memory/ranker";
import { createMemory, type CreateMemoryInput, type Memory } from "@/lib/memory/types";

// ──────────────────────────────────────────────
//  Fixtures
// ──────────────────────────────────────────────

function makeMemory(id: string, overrides: Partial<CreateMemoryInput> = {}): Memory {
  return createMemory({
    id,
    title: `Memory ${id}`,
    content: "Default content",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    tags: ["work"],
    ...overrides,
  });
}

// ──────────────────────────────────────────────
//  Weights
// ──────────────────────────────────────────────

describe("weights", () => {
  it("sum to 1", () => {
    const total = Object.values(MEMORY_RANKING_WEIGHTS).reduce((sum, w) => sum + w, 0);
    expect(total).toBeCloseTo(1);
  });

  it("cover every kind and source", () => {
    for (const kind of ["fact", "preference", "task", "knowledge", "conversation", "context"]) {
      expect(typeof MEMORY_KIND_WEIGHTS[kind as keyof typeof MEMORY_KIND_WEIGHTS]).toBe("number");
    }
    for (const source of ["user", "assistant", "system", "tool", "derived"]) {
      expect(typeof MEMORY_SOURCE_WEIGHTS[source as keyof typeof MEMORY_SOURCE_WEIGHTS]).toBe(
        "number",
      );
    }
  });
});

// ──────────────────────────────────────────────
//  Ranking behavior
// ──────────────────────────────────────────────

describe("rankMemories", () => {
  it("returns scores in [0, 1] and sorts descending", () => {
    const memories = [makeMemory("a"), makeMemory("b"), makeMemory("c")];
    const ranked = rankMemories(memories, "query");
    expect(ranked).toHaveLength(3);
    for (let index = 1; index < ranked.length; index += 1) {
      expect(ranked[index - 1].score).toBeGreaterThanOrEqual(ranked[index].score);
    }
    for (const result of ranked) {
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it("ranks semantically matching memories above non-matching ones", () => {
    // Matching memories use equal-length contents so the token score ties.
    const memories = [
      makeMemory("no", { content: "zzz unrelated" }),
      makeMemory("yes", { content: "coffee beans" }),
      makeMemory("also", { content: "coffee roast" }),
    ];
    const ranked = rankMemories(memories, "coffee");
    expect(ranked[0].id).toBe("yes");
    expect(ranked[1].id).toBe("also");
    expect(ranked[2].id).toBe("no");
  });

  it("prefers higher importance when other signals are equal", () => {
    const memories = [
      makeMemory("low", { importance: "low", content: "same content" }),
      makeMemory("critical", { importance: "critical", content: "same content" }),
      makeMemory("normal", { importance: "normal", content: "same content" }),
    ];
    const ranked = rankMemories(memories, "same content");
    expect(ranked.map((r) => r.id)).toEqual(["critical", "normal", "low"]);
  });

  it("prefers more recent memories when other signals are equal", () => {
    const memories = [
      makeMemory("old", { updatedAt: "2026-07-01T00:00:00.000Z", content: "same" }),
      makeMemory("new", { updatedAt: "2026-08-05T00:00:00.000Z", content: "same" }),
      makeMemory("mid", { updatedAt: "2026-07-20T00:00:00.000Z", content: "same" }),
    ];
    const ranked = rankMemories(memories, "same");
    expect(ranked.map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });

  it("prefers frequently accessed memories via accessCount", () => {
    const memories = [
      makeMemory("cold", { accessCount: 0, content: "same content" }),
      makeMemory("hot", { accessCount: 9, content: "same content" }),
    ];
    const ranked = rankMemories(memories, "same content");
    expect(ranked[0].id).toBe("hot");
  });

  it("prefers recently accessed memories via lastAccessedAt", () => {
    const memories = [
      makeMemory("touched", { lastAccessedAt: "2026-08-05T00:00:00.000Z", accessCount: 1, content: "same" }),
      makeMemory("never", { lastAccessedAt: null, accessCount: 1, content: "same" }),
    ];
    const ranked = rankMemories(memories, "same");
    expect(ranked[0].id).toBe("touched");
  });

  it("prefers compact memories via the token score", () => {
    const memories = [
      makeMemory("short", { content: "a" }),
      makeMemory("long", { content: "x".repeat(5000) }),
    ];
    const ranked = rankMemories(memories, "query");
    expect(ranked[0].id).toBe("short");
  });

  it("applies the conversation relevance boost", () => {
    const memories = [
      makeMemory("linked", { conversationId: "conv-1", content: "same content" }),
      makeMemory("other", { conversationId: "conv-2", content: "same content" }),
    ];
    const ranked = rankMemories(memories, "same content", { conversationId: "conv-1" });
    expect(ranked[0].id).toBe("linked");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked[0].score - ranked[1].score).toBeCloseTo(CONVERSATION_RELEVANCE_BOOST);
  });

  it("keeps an empty-query ranking deterministic", () => {
    const memories = [
      makeMemory("a", { importance: "high" }),
      makeMemory("b", { importance: "low" }),
    ];
    const ranked = rankMemories(memories, "");
    expect(ranked[0].id).toBe("a");
  });
});

// ──────────────────────────────────────────────
//  Stability, immutability, determinism
// ──────────────────────────────────────────────

describe("stability, immutability, determinism", () => {
  it("preserves input order for exact ties", () => {
    const tied = [
      makeMemory("x", { content: "identical", updatedAt: "2026-08-01T00:00:00.000Z" }),
      makeMemory("y", { content: "identical", updatedAt: "2026-08-01T00:00:00.000Z" }),
      makeMemory("z", { content: "identical", updatedAt: "2026-08-01T00:00:00.000Z" }),
    ];
    const ranked = rankMemories(tied, "identical");
    expect(ranked.map((r) => r.id)).toEqual(["x", "y", "z"]);
  });

  it("never mutates the input memories", () => {
    const memories = [makeMemory("a"), makeMemory("b")];
    const snapshot = JSON.stringify(memories);
    rankMemories(memories, "query");
    expect(JSON.stringify(memories)).toBe(snapshot);
  });

  it("returns new top-level objects", () => {
    const memories = [makeMemory("a")];
    const ranked = rankMemories(memories, "q");
    expect(ranked[0]).not.toBe(memories[0]);
  });

  it("produces identical rankings from identical inputs", () => {
    const build = (): string[] =>
      rankMemories(
        [
          makeMemory("a", { content: "alpha", importance: "high" }),
          makeMemory("b", { content: "beta", accessCount: 5 }),
          makeMemory("c", { content: "gamma", updatedAt: "2026-08-09T00:00:00.000Z" }),
        ],
        "alpha beta",
      ).map((r) => r.id);
    expect(build()).toEqual(build());
  });

  it("scales to 1000 memories", () => {
    const memories = Array.from({ length: 1000 }, (_, index) =>
      makeMemory(`m${index}`, {
        content: `content ${index}`,
        updatedAt: `2026-08-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
        importance: index % 4 === 0 ? "critical" : "normal",
        accessCount: index % 7,
      }),
    );
    const ranked = rankMemories(memories, "content");
    expect(ranked).toHaveLength(1000);
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[999].score);
  });
});
