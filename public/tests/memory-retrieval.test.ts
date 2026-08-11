import { describe, it, expect } from "vitest";
import { MemoryRepository } from "@/lib/memory/repository";
import { MemoryRetriever } from "@/lib/memory/retrieval";
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

/** A retriever seeded with a fixed, varied dataset. */
function makeSeededRetriever(): MemoryRetriever {
  const repository = new MemoryRepository([
    makeMemory("a", {
      title: "Meeting tomorrow",
      content: "Design review at 10am with the team.",
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
      kind: "task",
      importance: "high",
      source: "user",
      tags: ["work", "meeting"],
      conversationId: "conv-1",
    }),
    makeMemory("b", {
      title: "Coffee preference",
      content: "Prefers oat milk in coffee.",
      createdAt: "2026-08-01T11:00:00.000Z",
      updatedAt: "2026-08-03T10:00:00.000Z",
      kind: "preference",
      importance: "low",
      source: "assistant",
      tags: ["personal"],
    }),
    makeMemory("c", {
      title: "Project goal",
      content: "Ship the AI memory engine by Friday.",
      createdAt: "2026-08-02T09:00:00.000Z",
      updatedAt: "2026-08-02T09:00:00.000Z",
      kind: "fact",
      importance: "critical",
      source: "derived",
      tags: ["work", "project"],
      conversationId: "conv-1",
    }),
  ]);
  return new MemoryRetriever(repository);
}

// ──────────────────────────────────────────────
//  retrieveByQuery
// ──────────────────────────────────────────────

describe("retrieveByQuery", () => {
  it("matches title and content substrings case-insensitively", () => {
    const retriever = makeSeededRetriever();
    expect(retriever.retrieveByQuery("coffee").map((m) => m.id)).toEqual(["b"]);
    expect(retriever.retrieveByQuery("MEETING").map((m) => m.id)).toEqual(["a"]);
    expect(retriever.retrieveByQuery("memory engine").map((m) => m.id)).toEqual(["c"]);
  });

  it("matches tags exactly (case-insensitive)", () => {
    const retriever = makeSeededRetriever();
    expect(retriever.retrieveByQuery("project").map((m) => m.id)).toEqual(["c"]);
    expect(retriever.retrieveByQuery("PERSONAL").map((m) => m.id)).toEqual(["b"]);
  });

  it("matches when any token matches", () => {
    const retriever = makeSeededRetriever();
    // "xyz" matches nothing, but "coffee" matches b.
    expect(retriever.retrieveByQuery("xyz coffee").map((m) => m.id)).toEqual(["b"]);
  });

  it("returns [] for an empty query and for no matches", () => {
    const retriever = makeSeededRetriever();
    expect(retriever.retrieveByQuery("")).toEqual([]);
    expect(retriever.retrieveByQuery("   ")).toEqual([]);
    expect(retriever.retrieveByQuery("nothing-here")).toEqual([]);
  });

  it("preserves insertion order and honors limit", () => {
    const retriever = makeSeededRetriever();
    const all = retriever.retrieveByQuery("the"); // matches a ("the team"), c ("the AI")
    expect(all.map((m) => m.id)).toEqual(["a", "c"]);
    expect(retriever.retrieveByQuery("the", { limit: 1 }).map((m) => m.id)).toEqual(["a"]);
  });

  it("never mutates the repository", () => {
    const retriever = makeSeededRetriever();
    retriever.retrieveByQuery("coffee");
    expect(retriever.retrieveByQuery("coffee")).toEqual(retriever.retrieveByQuery("coffee"));
  });
});

// ──────────────────────────────────────────────
//  retrieveRecent
// ──────────────────────────────────────────────

describe("retrieveRecent", () => {
  it("returns the most recent memories by updatedAt, newest first", () => {
    const retriever = makeSeededRetriever();
    expect(retriever.retrieveRecent(2).map((m) => m.id)).toEqual(["b", "c"]);
    expect(retriever.retrieveRecent(3).map((m) => m.id)).toEqual(["b", "c", "a"]);
  });

  it("returns [] for a non-positive count", () => {
    const retriever = makeSeededRetriever();
    expect(retriever.retrieveRecent(0)).toEqual([]);
    expect(retriever.retrieveRecent(-2)).toEqual([]);
  });

  it("returns every memory when count exceeds the store", () => {
    const retriever = makeSeededRetriever();
    expect(retriever.retrieveRecent(100)).toHaveLength(3);
  });
});

// ──────────────────────────────────────────────
//  retrieveImportant / tags / kinds / source / conversation
// ──────────────────────────────────────────────

describe("filter retrievals", () => {
  it("retrieveImportant filters by importance", () => {
    const retriever = makeSeededRetriever();
    expect(retriever.retrieveImportant("critical").map((m) => m.id)).toEqual(["c"]);
    expect(retriever.retrieveImportant("low").map((m) => m.id)).toEqual(["b"]);
    expect(retriever.retrieveImportant("normal")).toEqual([]);
  });

  it("retrieveByTags supports any and all matching", () => {
    const retriever = makeSeededRetriever();
    expect(retriever.retrieveByTags(["work"]).map((m) => m.id)).toEqual(["a", "c"]);
    expect(retriever.retrieveByTags(["work"], "all").map((m) => m.id)).toEqual(["a", "c"]);
    // No memory has BOTH "meeting" and "project", so all-match is empty...
    expect(retriever.retrieveByTags(["meeting", "project"], "all")).toEqual([]);
    // ...while any-match finds the union.
    expect(retriever.retrieveByTags(["meeting", "project"], "any").map((m) => m.id)).toEqual([
      "a",
      "c",
    ]);
    expect(retriever.retrieveByTags(["meeting", "personal"], "all")).toEqual([]);
    expect(retriever.retrieveByTags([])).toEqual([]);
  });

  it("retrieveByKinds filters by kind", () => {
    const retriever = makeSeededRetriever();
    expect(retriever.retrieveByKinds(["task", "fact"]).map((m) => m.id)).toEqual(["a", "c"]);
    expect(retriever.retrieveByKinds(["knowledge"])).toEqual([]);
    expect(retriever.retrieveByKinds([])).toEqual([]);
  });

  it("retrieveBySource filters by source", () => {
    const retriever = makeSeededRetriever();
    expect(retriever.retrieveBySource(["assistant"]).map((m) => m.id)).toEqual(["b"]);
    expect(retriever.retrieveBySource(["user", "derived"]).map((m) => m.id)).toEqual(["a", "c"]);
    expect(retriever.retrieveBySource([])).toEqual([]);
  });

  it("retrieveByConversation filters by conversation linkage", () => {
    const retriever = makeSeededRetriever();
    expect(retriever.retrieveByConversation("conv-1").map((m) => m.id)).toEqual(["a", "c"]);
    expect(retriever.retrieveByConversation("conv-x")).toEqual([]);
  });
});

// ──────────────────────────────────────────────
//  retrieveWindow
// ──────────────────────────────────────────────

describe("retrieveWindow", () => {
  it("returns a bounded window of the most recent memories", () => {
    const retriever = makeSeededRetriever();
    const window = retriever.retrieveWindow(2);
    expect(window.memories.map((m) => m.id)).toEqual(["b", "c"]);
    expect(window.total).toBe(3);
    expect(window.trimmed).toBe(1);
  });

  it("returns everything for a limit at least as large as the store", () => {
    const retriever = makeSeededRetriever();
    const window = retriever.retrieveWindow(10);
    expect(window.memories).toHaveLength(3);
    expect(window.total).toBe(3);
    expect(window.trimmed).toBe(0);
  });

  it("returns an empty window for a non-positive limit", () => {
    const retriever = makeSeededRetriever();
    const window = retriever.retrieveWindow(0);
    expect(window.memories).toEqual([]);
    expect(window.total).toBe(3);
    expect(window.trimmed).toBe(3);
  });

  it("returns an empty window for an empty repository", () => {
    const retriever = new MemoryRetriever(new MemoryRepository());
    const window = retriever.retrieveWindow(5);
    expect(window.memories).toEqual([]);
    expect(window.total).toBe(0);
    expect(window.trimmed).toBe(0);
  });

  it("is deterministic and consistent with retrieveRecent", () => {
    const retriever = makeSeededRetriever();
    expect(retriever.retrieveWindow(2).memories).toEqual(retriever.retrieveWindow(2).memories);
    expect(retriever.retrieveWindow(2).memories).toEqual(retriever.retrieveRecent(2));
  });
});

// ──────────────────────────────────────────────
//  Determinism and scale
// ──────────────────────────────────────────────

describe("determinism and scale", () => {
  it("ties on updatedAt break deterministically by id", () => {
    const repository = new MemoryRepository([
      makeMemory("z", { updatedAt: "2026-08-02T00:00:00.000Z" }),
      makeMemory("a", { updatedAt: "2026-08-02T00:00:00.000Z" }),
      makeMemory("m", { updatedAt: "2026-08-02T00:00:00.000Z" }),
    ]);
    const retriever = new MemoryRetriever(repository);
    expect(retriever.retrieveRecent(3).map((m) => m.id)).toEqual(["a", "m", "z"]);
  });

  it("retrieves from a 1000-memory dataset correctly and quickly", () => {
    const memories: Memory[] = Array.from({ length: 1000 }, (_, index) =>
      makeMemory(`m${index}`, {
        content: `content ${index} alpha`,
        updatedAt: `2026-08-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
        tags: [`tag-${index % 10}`],
        importance: index % 5 === 0 ? "critical" : "normal",
        conversationId: index % 2 === 0 ? "conv-0" : "conv-1",
      }),
    );
    const retriever = new MemoryRetriever(new MemoryRepository(memories));

    expect(retriever.retrieveByQuery("alpha").length).toBeGreaterThan(0);
    expect(retriever.retrieveByQuery("alpha", { limit: 10 })).toHaveLength(10);
    expect(retriever.retrieveRecent(10)).toHaveLength(10);
    expect(retriever.retrieveByConversation("conv-0")).toHaveLength(500);
    expect(retriever.retrieveByTags(["tag-3"], "all")).toHaveLength(100);
    expect(retriever.retrieveImportant("critical")).toHaveLength(200);
    const window = retriever.retrieveWindow(5);
    expect(window.total).toBe(1000);
    expect(window.memories).toHaveLength(5);
    expect(window.trimmed).toBe(995);
  });
});
