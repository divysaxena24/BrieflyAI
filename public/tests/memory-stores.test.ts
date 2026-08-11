import { describe, it, expect } from "vitest";
import { MemoryStore, MemoryMergeError } from "@/lib/memory/stores";
import { MemoryRepository, MemoryNotFoundError } from "@/lib/memory/repository";
import { createMemory, type CreateMemoryInput, type Memory } from "@/lib/memory/types";

// ──────────────────────────────────────────────
//  Fixtures
// ──────────────────────────────────────────────

function makeMemory(id: string, overrides: Partial<CreateMemoryInput> = {}): Memory {
  return createMemory({
    id,
    title: `Memory ${id}`,
    content: "Some content",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    tags: ["work"],
    ...overrides,
  });
}

function makeShortTermStore(memories: readonly Memory[] = []): MemoryStore {
  return new MemoryStore(new MemoryRepository(memories), "short-term");
}

function makeLongTermStore(memories: readonly Memory[] = []): MemoryStore {
  return new MemoryStore(new MemoryRepository(memories), "long-term");
}

// ──────────────────────────────────────────────
//  Tier scoping
// ──────────────────────────────────────────────

describe("tier scoping", () => {
  it("scopes reads to its tier", () => {
    const store = makeShortTermStore([
      makeMemory("short-1", { tier: "short-term" }),
      makeMemory("long-1", { tier: "long-term" }),
    ]);
    expect(store.list().map((m) => m.id)).toEqual(["short-1"]);
    expect(store.count()).toBe(1);
    expect(store.find("short-1")?.id).toBe("short-1");
    expect(store.find("long-1")).toBeUndefined();
    expect(store.has("short-1")).toBe(true);
    expect(store.has("long-1")).toBe(false);
  });

  it("returns detached clones", () => {
    const store = makeShortTermStore([makeMemory("m1", { tier: "short-term" })]);
    store.list()[0].metadata.tags.push("x");
    expect(store.list()[0].metadata.tags).toEqual(["work"]);
  });
});

// ──────────────────────────────────────────────
//  add
// ──────────────────────────────────────────────

describe("add", () => {
  it("stores a memory in the store's tier, overriding the input tier", () => {
    const store = makeLongTermStore();
    const { store: next, memory } = store.add(makeMemory("m1", { tier: "short-term" }));
    expect(memory.metadata.tier).toBe("long-term");
    expect(next.count()).toBe(1);
    expect(next.find("m1")?.metadata.tier).toBe("long-term");
  });

  it("keeps the receiver unchanged", () => {
    const store = makeShortTermStore();
    store.add(makeMemory("m1"));
    expect(store.count()).toBe(0);
  });

  it("rejects duplicate ids", () => {
    const store = makeShortTermStore([makeMemory("m1", { tier: "short-term" })]);
    expect(() => store.add(makeMemory("m1"))).toThrow();
  });
});

// ──────────────────────────────────────────────
//  promote / demote
// ──────────────────────────────────────────────

describe("promote and demote", () => {
  it("promotes a short-term memory to long-term", () => {
    const store = makeShortTermStore([makeMemory("m1", { tier: "short-term" })]);
    const { store: next, memory } = store.promote("m1", "2026-08-05T10:00:00.000Z");
    expect(memory.metadata.tier).toBe("long-term");
    expect(memory.metadata.updatedAt).toBe("2026-08-05T10:00:00.000Z");
    // It leaves the short-term store's view...
    expect(next.count()).toBe(0);
    // ...and is visible through a long-term store over the successor repo.
    expect(new MemoryStore(next.repository, "long-term").count()).toBe(1);
  });

  it("demotes a long-term memory to short-term", () => {
    const store = makeLongTermStore([makeMemory("m1", { tier: "long-term" })]);
    const { store: next, memory } = store.demote("m1");
    expect(memory.metadata.tier).toBe("short-term");
    expect(next.count()).toBe(0);
  });

  it("does not change updatedAt when no timestamp is given", () => {
    const store = makeShortTermStore([makeMemory("m1", { tier: "short-term" })]);
    const { memory } = store.promote("m1");
    expect(memory.metadata.updatedAt).toBe("2026-08-01T10:00:00.000Z");
  });

  it("leaves the receiver unchanged", () => {
    const store = makeShortTermStore([makeMemory("m1", { tier: "short-term" })]);
    store.promote("m1");
    expect(store.find("m1")?.metadata.tier).toBe("short-term");
  });

  it("throws for unknown or other-tier ids", () => {
    const store = makeShortTermStore([makeMemory("long-1", { tier: "long-term" })]);
    expect(() => store.promote("missing")).toThrow(MemoryNotFoundError);
    expect(() => store.promote("long-1")).toThrow(MemoryNotFoundError);
  });
});

// ──────────────────────────────────────────────
//  merge
// ──────────────────────────────────────────────

describe("merge", () => {
  it("merges memories into one derived memory and removes the sources", () => {
    const store = makeShortTermStore([
      makeMemory("a", {
        tier: "short-term",
        title: "Coffee",
        content: "Prefers oat milk.",
        kind: "preference",
        importance: "high",
        tags: ["coffee", "personal"],
        conversationId: "conv-1",
        accessCount: 2,
        createdAt: "2026-08-01T10:00:00.000Z",
      }),
      makeMemory("b", {
        tier: "short-term",
        title: "Tea",
        content: "Prefers green tea.",
        kind: "preference",
        importance: "normal",
        tags: ["tea", "personal"],
        accessCount: 3,
        createdAt: "2026-08-02T10:00:00.000Z",
      }),
    ]);
    const { store: next, memory } = store.merge(["a", "b"], "2026-08-06T10:00:00.000Z");

    expect(next.has("a")).toBe(false);
    expect(next.has("b")).toBe(false);
    expect(next.count()).toBe(1);

    expect(memory.metadata.source).toBe("derived");
    expect(memory.metadata.tier).toBe("short-term");
    expect(memory.metadata.title).toBe("Coffee");
    expect(memory.content).toBe("Prefers oat milk.\n\nPrefers green tea.");
    expect(memory.metadata.kind).toBe("preference");
    expect(memory.metadata.importance).toBe("high");
    expect(memory.metadata.tags).toEqual(["coffee", "personal", "tea"]);
    expect(memory.metadata.accessCount).toBe(5);
    expect(memory.metadata.createdAt).toBe("2026-08-01T10:00:00.000Z");
    expect(memory.metadata.updatedAt).toBe("2026-08-06T10:00:00.000Z");
    expect(memory.metadata.conversationId).toBe("conv-1");
    expect(memory.metadata.state).toBe("active");
  });

  it("is deterministic regardless of input id order", () => {
    const store = makeShortTermStore([
      makeMemory("a", { tier: "short-term", content: "A content", importance: "low" }),
      makeMemory("b", { tier: "short-term", content: "B content", importance: "critical" }),
    ]);
    const first = store.merge(["a", "b"], "t").memory;
    const second = store.merge(["b", "a"], "t").memory;
    expect(first.id).toBe(second.id);
    expect(first).toEqual(second);
  });

  it("throws for fewer than two ids and for unknown ids", () => {
    const store = makeShortTermStore([makeMemory("a", { tier: "short-term" })]);
    expect(() => store.merge(["a"], "t")).toThrow(MemoryMergeError);
    expect(() => store.merge(["a", "missing"], "t")).toThrow(MemoryNotFoundError);
  });
});

// ──────────────────────────────────────────────
//  prune
// ──────────────────────────────────────────────

describe("prune", () => {
  it("removes expired memories of the tier", () => {
    const store = makeShortTermStore([
      makeMemory("fresh", {
        tier: "short-term",
        expiresAt: "2026-09-01T00:00:00.000Z",
      }),
      makeMemory("stale", {
        tier: "short-term",
        expiresAt: "2026-07-01T00:00:00.000Z",
      }),
      makeMemory("none", { tier: "short-term" }),
      makeMemory("other-tier", { tier: "long-term", expiresAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    const next = store.prune("2026-08-01T00:00:00.000Z");
    expect(next.list().map((m) => m.id)).toEqual(["fresh", "none"]);
    // Other-tier memories are untouched by this store's prune.
    expect(new MemoryStore(next.repository, "long-term").count()).toBe(1);
  });

  it("optionally removes archived memories", () => {
    const store = makeShortTermStore([
      makeMemory("active", { tier: "short-term" }),
      makeMemory("archived", { tier: "short-term", state: "archived" }),
    ]);
    expect(store.prune("2026-08-01T00:00:00.000Z").count()).toBe(2);
    expect(store.prune("2026-08-01T00:00:00.000Z", { removeArchived: true }).count()).toBe(1);
  });

  it("leaves the receiver unchanged", () => {
    const store = makeShortTermStore([makeMemory("stale", { tier: "short-term", expiresAt: "2026-07-01T00:00:00.000Z" })]);
    store.prune("2026-08-01T00:00:00.000Z");
    expect(store.count()).toBe(1);
  });
});

// ──────────────────────────────────────────────
//  trim
// ──────────────────────────────────────────────

describe("trim", () => {
  it("keeps the most recent maxItems by updatedAt", () => {
    const store = makeShortTermStore([
      makeMemory("old", { tier: "short-term", updatedAt: "2026-08-01T10:00:00.000Z" }),
      makeMemory("mid", { tier: "short-term", updatedAt: "2026-08-03T10:00:00.000Z" }),
      makeMemory("new", { tier: "short-term", updatedAt: "2026-08-05T10:00:00.000Z" }),
    ]);
    const next = store.trim(2);
    expect(next.list().map((m) => m.id)).toEqual(["mid", "new"]);
  });

  it("empties the tier for a non-positive maxItems", () => {
    const store = makeShortTermStore([
      makeMemory("a", { tier: "short-term" }),
      makeMemory("b", { tier: "short-term" }),
    ]);
    expect(store.trim(0).count()).toBe(0);
    expect(store.trim(-1).count()).toBe(0);
  });

  it("keeps everything when maxItems covers the tier", () => {
    const store = makeShortTermStore([makeMemory("a", { tier: "short-term" })]);
    expect(store.trim(10).count()).toBe(1);
  });

  it("leaves the receiver unchanged", () => {
    const store = makeShortTermStore([makeMemory("a", { tier: "short-term" })]);
    store.trim(0);
    expect(store.count()).toBe(1);
  });
});

// ──────────────────────────────────────────────
//  Determinism and scale
// ──────────────────────────────────────────────

describe("determinism and scale", () => {
  it("produces deep-equal store states from identical operation sequences", () => {
    const run = (): MemoryStore => {
      let store = makeShortTermStore();
      store = store.add(makeMemory("a", { tier: "short-term" })).store;
      store = store.add(makeMemory("b", { tier: "short-term" })).store;
      store = store.merge(["a", "b"], "2026-08-06T10:00:00.000Z").store;
      store = store.add(makeMemory("c", { tier: "short-term" })).store;
      return store.trim(1);
    };
    expect(run().list()).toEqual(run().list());
  });

  it("handles 1000 short-term memories with trim and prune", () => {
    const memories: Memory[] = Array.from({ length: 1000 }, (_, index) =>
      makeMemory(`m${index}`, {
        tier: "short-term",
        updatedAt: `2026-08-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
        expiresAt: index % 3 === 0 ? "2026-07-01T00:00:00.000Z" : undefined,
      }),
    );
    let store = makeShortTermStore(memories);
    expect(store.count()).toBe(1000);
    store = store.prune("2026-08-01T00:00:00.000Z");
    expect(store.count()).toBe(666);
    store = store.trim(10);
    expect(store.count()).toBe(10);
  });
});
