import { describe, it, expect } from "vitest";
import {
  searchMemories,
  semanticScoreOf,
  tokenizeQuery,
  SEMANTIC_WEIGHTS,
} from "@/lib/memory/semanticSearch";
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
    tags: ["work"],
    ...overrides,
  });
}

// ──────────────────────────────────────────────
//  tokenizeQuery
// ──────────────────────────────────────────────

describe("tokenizeQuery", () => {
  it("splits on whitespace and lowercases", () => {
    expect(tokenizeQuery("Project  Status")).toEqual(["project", "status"]);
  });

  it("drops empty tokens", () => {
    expect(tokenizeQuery("   a   b   ")).toEqual(["a", "b"]);
    expect(tokenizeQuery("")).toEqual([]);
  });
});

// ──────────────────────────────────────────────
//  semanticScoreOf
// ──────────────────────────────────────────────

describe("semanticScoreOf", () => {
  it("scores 0 for an empty query", () => {
    const memory = makeMemory("m1", { content: "alpha beta" });
    expect(semanticScoreOf(memory, "")).toBe(0);
  });

  it("scores content overlap with weight 0.4", () => {
    const memory = makeMemory("m1", { content: "alpha beta gamma" });
    // 1 of 2 tokens ("beta") matches content → 0.4 × 0.5 = 0.2.
    expect(semanticScoreOf(memory, "beta delta")).toBe(SEMANTIC_WEIGHTS.content * 0.5);
  });

  it("scores title overlap with weight 0.3", () => {
    const memory = makeMemory("m1", { title: "Project roadmap", content: "zzz" });
    expect(semanticScoreOf(memory, "roadmap")).toBe(SEMANTIC_WEIGHTS.title * 1);
  });

  it("scores tag overlap with weight 0.2", () => {
    const memory = makeMemory("m1", { tags: ["meeting"] });
    expect(semanticScoreOf(memory, "meeting")).toBe(SEMANTIC_WEIGHTS.tags * 1);
  });

  it("scores metadata overlap with weight 0.1 (conversationId and extra)", () => {
    const memory = makeMemory("m1", { conversationId: "conv-7" });
    expect(semanticScoreOf(memory, "conv-7")).toBe(SEMANTIC_WEIGHTS.metadata * 1);
    const withExtra = makeMemory("m1", { extra: { project: "Apollo" } });
    expect(semanticScoreOf(withExtra, "apollo")).toBe(SEMANTIC_WEIGHTS.metadata * 1);
  });

  it("combines all signals into a weighted blend", () => {
    const memory = makeMemory("m1", {
      title: "coffee",
      content: "coffee",
      tags: ["coffee"],
      conversationId: "coffee",
    });
    // Every token in every field → full score 1.
    expect(semanticScoreOf(memory, "coffee")).toBeCloseTo(1);
  });

  it("is deterministic and never mutates the memory", () => {
    const memory = makeMemory("m1", { content: "alpha beta" });
    const snapshot = JSON.stringify(memory);
    expect(semanticScoreOf(memory, "alpha")).toBe(semanticScoreOf(memory, "alpha"));
    expect(JSON.stringify(memory)).toBe(snapshot);
  });
});

// ──────────────────────────────────────────────
//  searchMemories
// ──────────────────────────────────────────────

describe("searchMemories", () => {
  const memories = [
    makeMemory("exact", { title: "Coffee preference", content: "Prefers oat milk coffee.", tags: ["coffee"] }),
    makeMemory("partial", { content: "Coffee machine is broken." }),
    makeMemory("unrelated", { content: "The weather is nice today." }),
  ];

  it("returns only memories with a positive semantic score, sorted descending", () => {
    const results = searchMemories(memories, "coffee");
    expect(results.map((r) => r.id)).toEqual(["exact", "partial"]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("requires every token when requireAll is set", () => {
    const results = searchMemories(memories, "coffee broken", { requireAll: true });
    expect(results.map((r) => r.id)).toEqual(["partial"]);
  });

  it("returns [] for an empty query or no matches", () => {
    expect(searchMemories(memories, "")).toEqual([]);
    expect(searchMemories(memories, "xyzzy")).toEqual([]);
  });

  it("preserves input order for equal scores (stable sort)", () => {
    const tied = [
      makeMemory("a", { content: "same phrase" }),
      makeMemory("b", { content: "same phrase" }),
      makeMemory("c", { content: "same phrase" }),
    ];
    const results = searchMemories(tied, "same phrase");
    expect(results.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(results[0].score).toBe(results[1].score);
  });

  it("returns new top-level objects and never mutates inputs", () => {
    const snapshot = JSON.stringify(memories);
    const results = searchMemories(memories, "coffee");
    expect(results[0]).not.toBe(memories[0]);
    results[0].score = 0.99;
    expect(JSON.stringify(memories)).toBe(snapshot);
  });

  it("scales to 1000 memories", () => {
    const big = Array.from({ length: 1000 }, (_, index) =>
      makeMemory(`m${index}`, {
        content: index % 3 === 0 ? "alpha beta" : "gamma delta",
        tags: [index % 5 === 0 ? "target" : "other"],
      }),
    );
    const results = searchMemories(big, "alpha");
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(1000);
    expect(results.every((r) => r.score > 0)).toBe(true);
  });
});
