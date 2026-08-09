import { describe, it, expect } from "vitest";
import {
  MemoryRepository,
  MemoryNotFoundError,
  MemoryDuplicateError,
  type MemoryPatch,
} from "@/lib/memory/repository";
import { createMemory, type Memory } from "@/lib/memory/types";

// ──────────────────────────────────────────────
//  Fixtures
// ──────────────────────────────────────────────

function makeMemory(id: string, overrides: Partial<Parameters<typeof createMemory>[0]> = {}): Memory {
  return createMemory({
    id,
    title: `Memory ${id}`,
    content: "Some content",
    createdAt: "2026-08-01T10:00:00.000Z",
    tags: ["work"],
    ...overrides,
  });
}

// ──────────────────────────────────────────────
//  Construction
// ──────────────────────────────────────────────

describe("construction", () => {
  it("starts empty when constructed without arguments", () => {
    const repository = new MemoryRepository();
    expect(repository.count()).toBe(0);
    expect(repository.list()).toEqual([]);
  });

  it("stores the initial memories in order", () => {
    const repository = new MemoryRepository([makeMemory("m1"), makeMemory("m2")]);
    expect(repository.count()).toBe(2);
    expect(repository.list().map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("snapshots the constructor input (later caller mutation has no effect)", () => {
    const initial = [makeMemory("m1")];
    const repository = new MemoryRepository(initial);
    initial.push(makeMemory("m2"));
    initial[0].metadata.tags.push("extra");
    expect(repository.count()).toBe(1);
    expect(repository.find("m1")?.metadata.tags).toEqual(["work"]);
  });

  it("stores detached frozen copies", () => {
    const repository = new MemoryRepository([makeMemory("m1")]);
    const first = repository.find("m1") as Memory;
    expect(first).not.toBe(repository.find("m1"));
    expect(repository.find("m1")).toEqual(first);
  });
});

// ──────────────────────────────────────────────
//  add
// ──────────────────────────────────────────────

describe("add", () => {
  it("appends a memory and returns it plus the successor repository", () => {
    const repository = new MemoryRepository();
    const { memory, repository: next } = repository.add(makeMemory("m1"));
    expect(memory.id).toBe("m1");
    expect(next.count()).toBe(1);
    expect(next.list()[0].id).toBe("m1");
  });

  it("keeps the receiver unchanged (immutability)", () => {
    const repository = new MemoryRepository();
    repository.add(makeMemory("m1"));
    expect(repository.count()).toBe(0);
  });

  it("preserves insertion order across adds", () => {
    let repository = new MemoryRepository();
    const first = repository.add(makeMemory("a"));
    repository = first.repository;
    const second = repository.add(makeMemory("b"));
    repository = second.repository;
    const third = repository.add(makeMemory("c"));
    expect(third.repository.list().map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("rejects duplicate ids", () => {
    const repository = new MemoryRepository([makeMemory("m1")]);
    expect(() => repository.add(makeMemory("m1"))).toThrow(MemoryDuplicateError);
  });
});

// ──────────────────────────────────────────────
//  update
// ──────────────────────────────────────────────

describe("update", () => {
  it("applies a partial patch and returns the patched memory plus the successor", () => {
    const repository = new MemoryRepository([makeMemory("m1")]);
    const patch: MemoryPatch = { title: "Renamed", importance: "high" };
    const { memory, repository: next } = repository.update("m1", patch);
    expect(memory.metadata.title).toBe("Renamed");
    expect(memory.metadata.importance).toBe("high");
    expect(memory.metadata.kind).toBe("knowledge");
    expect(memory.content).toBe("Some content");
    expect(next.find("m1")?.metadata.title).toBe("Renamed");
    expect(next.find("m1")?.metadata.tags).toEqual(["work"]);
  });

  it("copies tags and extra when patched", () => {
    const repository = new MemoryRepository([makeMemory("m1")]);
    const { repository: next } = repository.update("m1", {
      tags: ["a", "b"],
      extra: { k: 2 },
    });
    expect(next.find("m1")?.metadata.tags).toEqual(["a", "b"]);
    expect(next.find("m1")?.extra).toEqual({ k: 2 });
  });

  it("clears conversationId and expiresAt with null", () => {
    const repository = new MemoryRepository([
      makeMemory("m1", { conversationId: "c1", expiresAt: "2026-09-01T00:00:00.000Z" }),
    ]);
    const { memory } = repository.update("m1", { conversationId: null, expiresAt: null });
    expect(memory.metadata.conversationId).toBeUndefined();
    expect(memory.metadata.expiresAt).toBeUndefined();
  });

  it("keeps insertion position when updating", () => {
    const repository = new MemoryRepository([makeMemory("a"), makeMemory("b"), makeMemory("c")]);
    const { repository: next } = repository.update("b", { title: "B2" });
    expect(next.list().map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(next.list()[1].metadata.title).toBe("B2");
  });

  it("leaves the receiver unchanged (immutability)", () => {
    const repository = new MemoryRepository([makeMemory("m1")]);
    repository.update("m1", { title: "X" });
    expect(repository.find("m1")?.metadata.title).toBe("Memory m1");
  });

  it("throws for an unknown id", () => {
    const repository = new MemoryRepository();
    expect(() => repository.update("missing", { title: "X" })).toThrow(MemoryNotFoundError);
  });
});

// ──────────────────────────────────────────────
//  replace / remove / clear
// ──────────────────────────────────────────────

describe("replace", () => {
  it("replaces the stored memory by id, keeping position", () => {
    const repository = new MemoryRepository([makeMemory("a"), makeMemory("b")]);
    const next = repository.replace(makeMemory("b", { title: "B2", content: "new" }));
    expect(next.list().map((m) => m.id)).toEqual(["a", "b"]);
    expect(next.find("b")?.metadata.title).toBe("B2");
    expect(next.find("b")?.content).toBe("new");
  });

  it("detaches the replacement from the caller", () => {
    const replacement = makeMemory("m1");
    const repository = new MemoryRepository();
    const { repository: withOne } = repository.add(makeMemory("m1"));
    const next = withOne.replace(replacement);
    replacement.metadata.tags.push("changed");
    (replacement as unknown as { content: string }).content = "changed";
    expect(next.find("m1")?.metadata.tags).toEqual(["work"]);
    expect(next.find("m1")?.content).toBe("Some content");
  });

  it("throws for an unknown id", () => {
    const repository = new MemoryRepository();
    expect(() => repository.replace(makeMemory("missing"))).toThrow(MemoryNotFoundError);
  });
});

describe("remove and clear", () => {
  it("removes a memory", () => {
    const repository = new MemoryRepository([makeMemory("m1"), makeMemory("m2")]);
    const next = repository.remove("m1");
    expect(next.has("m1")).toBe(false);
    expect(next.has("m2")).toBe(true);
    expect(next.count()).toBe(1);
  });

  it("throws for an unknown id on remove", () => {
    const repository = new MemoryRepository();
    expect(() => repository.remove("missing")).toThrow(MemoryNotFoundError);
  });

  it("clear returns an empty repository", () => {
    const repository = new MemoryRepository([makeMemory("m1"), makeMemory("m2")]);
    const cleared = repository.clear();
    expect(cleared.count()).toBe(0);
    expect(cleared.list()).toEqual([]);
    expect(repository.count()).toBe(2);
  });
});

// ──────────────────────────────────────────────
//  find and filters
// ──────────────────────────────────────────────

describe("find and filters", () => {
  const repository = new MemoryRepository([
    makeMemory("a", { kind: "fact", importance: "high", source: "user", tags: ["work", "project"] }),
    makeMemory("b", { kind: "preference", importance: "low", source: "assistant", tags: ["work"] }),
    makeMemory("c", { kind: "fact", importance: "critical", source: "derived", tags: ["personal"] }),
  ]);

  it("find returns a detached clone or undefined", () => {
    expect(repository.find("a")?.id).toBe("a");
    expect(repository.find("missing")).toBeUndefined();
  });

  it("findByKind filters by kind", () => {
    expect(repository.findByKind("fact").map((m) => m.id)).toEqual(["a", "c"]);
    expect(repository.findByKind("task")).toEqual([]);
  });

  it("findByTag filters by tag", () => {
    expect(repository.findByTag("work").map((m) => m.id)).toEqual(["a", "b"]);
    expect(repository.findByTag("nope")).toEqual([]);
  });

  it("findByImportance filters by importance", () => {
    expect(repository.findByImportance("high").map((m) => m.id)).toEqual(["a"]);
    expect(repository.findByImportance("critical").map((m) => m.id)).toEqual(["c"]);
  });

  it("findBySource filters by source", () => {
    expect(repository.findBySource("assistant").map((m) => m.id)).toEqual(["b"]);
    expect(repository.findBySource("tool")).toEqual([]);
  });

  it("filters return detached clones", () => {
    const results = repository.findByTag("work");
    results[0].metadata.tags.push("mutated");
    expect(repository.findByTag("work")[0].metadata.tags).toEqual(["work", "project"]);
  });
});

// ──────────────────────────────────────────────
//  has / count / determinism / scale
// ──────────────────────────────────────────────

describe("has, count, determinism, scale", () => {
  it("reports membership and count", () => {
    const repository = new MemoryRepository([makeMemory("m1")]);
    expect(repository.has("m1")).toBe(true);
    expect(repository.has("missing")).toBe(false);
    expect(repository.count()).toBe(1);
  });

  it("produces deep-equal repositories from identical operation sequences", () => {
    const run = (): MemoryRepository => {
      let repository = new MemoryRepository();
      const first = repository.add(makeMemory("a", { kind: "fact" }));
      repository = first.repository;
      const second = repository.add(makeMemory("b"));
      repository = second.repository;
      const updated = repository.update("a", { importance: "high" });
      repository = updated.repository;
      repository = repository.remove("b");
      return repository;
    };
    expect(run().list()).toEqual(run().list());
  });

  it("handles 1000 memories with correct ordering and counts", () => {
    let repository = new MemoryRepository();
    for (let index = 0; index < 1000; index += 1) {
      const added = repository.add(makeMemory(`m${index}`));
      repository = added.repository;
    }
    expect(repository.count()).toBe(1000);
    expect(repository.list()[0].id).toBe("m0");
    expect(repository.list()[999].id).toBe("m999");
    const removed = repository.remove("m500");
    expect(removed.count()).toBe(999);
    expect(removed.list()[500].id).toBe("m501");
  });

  it("update is O(n) friendly at scale (1000 memories)", () => {
    let repository = new MemoryRepository();
    for (let index = 0; index < 1000; index += 1) {
      const added = repository.add(makeMemory(`m${index}`));
      repository = added.repository;
    }
    const { repository: updated } = repository.update("m999", { title: "last" });
    expect(updated.find("m999")?.metadata.title).toBe("last");
    expect(updated.count()).toBe(1000);
  });
});
