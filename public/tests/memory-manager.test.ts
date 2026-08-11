import { describe, it, expect } from "vitest";
import { MemoryManager } from "@/lib/memory/manager";
import { MemoryRepository, MemoryNotFoundError, MemoryDuplicateError } from "@/lib/memory/repository";
import { createMemory, type CreateMemoryInput, type Memory } from "@/lib/memory/types";

// ──────────────────────────────────────────────
//  Fixtures
// ──────────────────────────────────────────────

function makeMemoryInput(id: string, overrides: Partial<CreateMemoryInput> = {}): CreateMemoryInput {
  return {
    id,
    title: `Memory ${id}`,
    content: "Some content",
    createdAt: "2026-08-01T10:00:00.000Z",
    tags: ["work"],
    ...overrides,
  };
}

function makeMemory(id: string, overrides: Partial<CreateMemoryInput> = {}): Memory {
  return createMemory(makeMemoryInput(id, overrides));
}

// ──────────────────────────────────────────────
//  Construction / reads
// ──────────────────────────────────────────────

describe("construction and reads", () => {
  it("starts empty with an empty repository", () => {
    const manager = new MemoryManager();
    expect(manager.count()).toBe(0);
    expect(manager.list()).toEqual([]);
  });

  it("is seeded by an initial repository", () => {
    const repository = new MemoryRepository([makeMemory("m1")]);
    const manager = new MemoryManager(repository);
    expect(manager.count()).toBe(1);
    expect(manager.find("m1")?.id).toBe("m1");
  });

  it("delegates membership checks to the repository", () => {
    const manager = new MemoryManager(new MemoryRepository([makeMemory("m1")]));
    expect(manager.has("m1")).toBe(true);
    expect(manager.has("missing")).toBe(false);
  });

  it("returns detached clones on reads", () => {
    const manager = new MemoryManager(new MemoryRepository([makeMemory("m1")]));
    const first = manager.find("m1");
    first?.metadata.tags.push("x");
    expect(manager.find("m1")?.metadata.tags).toEqual(["work"]);
  });
});

// ──────────────────────────────────────────────
//  remember
// ──────────────────────────────────────────────

describe("remember", () => {
  it("creates a memory and returns it plus the successor manager", () => {
    const manager = new MemoryManager();
    const { manager: next, memory } = manager.remember(makeMemoryInput("m1"));
    expect(memory.id).toBe("m1");
    expect(next.count()).toBe(1);
    expect(next.find("m1")?.metadata.state).toBe("active");
    expect(next.find("m1")?.metadata.tier).toBe("short-term");
  });

  it("keeps the receiver unchanged (immutability)", () => {
    const manager = new MemoryManager();
    manager.remember(makeMemoryInput("m1"));
    expect(manager.count()).toBe(0);
  });

  it("preserves insertion order across remembers", () => {
    let manager = new MemoryManager();
    manager = manager.remember(makeMemoryInput("a")).manager;
    manager = manager.remember(makeMemoryInput("b")).manager;
    manager = manager.remember(makeMemoryInput("c")).manager;
    expect(manager.list().map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("rejects duplicate ids", () => {
    const manager = new MemoryManager(new MemoryRepository([makeMemory("m1")]));
    expect(() => manager.remember(makeMemoryInput("m1"))).toThrow(MemoryDuplicateError);
  });

  it("derives a deterministic id when none is given", () => {
    const manager = new MemoryManager();
    const input = { title: "T", content: "C", createdAt: "2026-08-01T10:00:00.000Z" };
    const first = manager.remember(input).memory;
    const second = new MemoryManager().remember(input).memory;
    expect(first.id).toBe(second.id);
  });
});

// ──────────────────────────────────────────────
//  forget / deleteMemory
// ──────────────────────────────────────────────

describe("forget and deleteMemory", () => {
  it("forget soft-deletes (state 'deleted') while keeping the memory stored", () => {
    const manager = new MemoryManager(new MemoryRepository([makeMemory("m1")]));
    const next = manager.forget("m1");
    expect(next.find("m1")?.metadata.state).toBe("deleted");
    expect(next.count()).toBe(1);
  });

  it("forget is recoverable via restoreMemory", () => {
    const manager = new MemoryManager(new MemoryRepository([makeMemory("m1")]));
    const reopened = manager.forget("m1").restoreMemory("m1");
    expect(reopened.find("m1")?.metadata.state).toBe("active");
  });

  it("deleteMemory removes the memory entirely (hard delete)", () => {
    const manager = new MemoryManager(new MemoryRepository([makeMemory("m1")]));
    const deleted = manager.deleteMemory("m1");
    expect(deleted.count()).toBe(0);
    expect(deleted.has("m1")).toBe(false);
  });

  it("forget and delete are distinct operations", () => {
    const manager = new MemoryManager(new MemoryRepository([makeMemory("m1")]));
    expect(manager.forget("m1").has("m1")).toBe(true);
    expect(manager.deleteMemory("m1").has("m1")).toBe(false);
  });

  it("both leave the receiver unchanged", () => {
    const manager = new MemoryManager(new MemoryRepository([makeMemory("m1")]));
    manager.forget("m1");
    manager.deleteMemory("m1");
    expect(manager.find("m1")?.metadata.state).toBe("active");
    expect(manager.count()).toBe(1);
  });

  it("throws for unknown ids", () => {
    const manager = new MemoryManager();
    expect(() => manager.forget("missing")).toThrow(MemoryNotFoundError);
    expect(() => manager.deleteMemory("missing")).toThrow(MemoryNotFoundError);
  });
});

// ──────────────────────────────────────────────
//  updateMemory / touchMemory / archive / restore
// ──────────────────────────────────────────────

describe("updateMemory", () => {
  it("patches a memory and returns it plus the successor manager", () => {
    const manager = new MemoryManager(new MemoryRepository([makeMemory("m1")]));
    const { manager: next, memory } = manager.updateMemory("m1", {
      title: "Renamed",
      importance: "high",
    });
    expect(memory.metadata.title).toBe("Renamed");
    expect(memory.metadata.importance).toBe("high");
    expect(next.find("m1")?.metadata.title).toBe("Renamed");
  });

  it("keeps the receiver unchanged (immutability)", () => {
    const manager = new MemoryManager(new MemoryRepository([makeMemory("m1")]));
    manager.updateMemory("m1", { title: "X" });
    expect(manager.find("m1")?.metadata.title).toBe("Memory m1");
  });

  it("throws for an unknown id", () => {
    const manager = new MemoryManager();
    expect(() => manager.updateMemory("missing", { title: "X" })).toThrow(MemoryNotFoundError);
  });
});

describe("touchMemory", () => {
  it("updates lastAccessedAt and accessCount", () => {
    const manager = new MemoryManager(new MemoryRepository([makeMemory("m1")]));
    const { manager: next, memory } = manager.touchMemory("m1", "2026-08-03T10:00:00.000Z");
    expect(memory.metadata.lastAccessedAt).toBe("2026-08-03T10:00:00.000Z");
    expect(memory.metadata.accessCount).toBe(1);
    expect(next.find("m1")?.metadata.accessCount).toBe(1);
    expect(manager.find("m1")?.metadata.accessCount).toBe(0);
  });

  it("accumulates accesses and does not change updatedAt", () => {
    let manager = new MemoryManager(new MemoryRepository([makeMemory("m1")]));
    manager = manager.touchMemory("m1", "2026-08-03T10:00:00.000Z").manager;
    manager = manager.touchMemory("m1", "2026-08-04T10:00:00.000Z").manager;
    const memory = manager.find("m1");
    expect(memory?.metadata.accessCount).toBe(2);
    expect(memory?.metadata.updatedAt).toBe("2026-08-01T10:00:00.000Z");
  });

  it("throws for an unknown id", () => {
    const manager = new MemoryManager();
    expect(() => manager.touchMemory("missing", "t")).toThrow(MemoryNotFoundError);
  });
});

describe("archiveMemory and restoreMemory", () => {
  it("archives and restores", () => {
    const manager = new MemoryManager(new MemoryRepository([makeMemory("m1")]));
    const archived = manager.archiveMemory("m1");
    expect(archived.find("m1")?.metadata.state).toBe("archived");
    const restored = archived.restoreMemory("m1");
    expect(restored.find("m1")?.metadata.state).toBe("active");
  });

  it("throws for unknown ids", () => {
    const manager = new MemoryManager();
    expect(() => manager.archiveMemory("missing")).toThrow(MemoryNotFoundError);
    expect(() => manager.restoreMemory("missing")).toThrow(MemoryNotFoundError);
  });
});

// ──────────────────────────────────────────────
//  bulk operations
// ──────────────────────────────────────────────

describe("bulkRemember and bulkForget", () => {
  it("remembers many memories atomically", () => {
    const manager = new MemoryManager();
    const { manager: next, added } = manager.bulkRemember([
      makeMemoryInput("a"),
      makeMemoryInput("b"),
      makeMemoryInput("c"),
    ]);
    expect(added).toHaveLength(3);
    expect(next.count()).toBe(3);
    expect(next.list().map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("leaves the receiver unchanged after bulkRemember", () => {
    const manager = new MemoryManager();
    manager.bulkRemember([makeMemoryInput("a"), makeMemoryInput("b")]);
    expect(manager.count()).toBe(0);
  });

  it("throws on the first duplicate id", () => {
    const manager = new MemoryManager(new MemoryRepository([makeMemory("a")]));
    expect(() =>
      manager.bulkRemember([makeMemoryInput("x"), makeMemoryInput("a")]),
    ).toThrow(MemoryDuplicateError);
    expect(manager.count()).toBe(1);
  });

  it("forgets many memories atomically", () => {
    const manager = new MemoryManager(
      new MemoryRepository([makeMemory("a"), makeMemory("b"), makeMemory("c")]),
    );
    const next = manager.bulkForget(["a", "c"]);
    expect(next.find("a")?.metadata.state).toBe("deleted");
    expect(next.find("b")?.metadata.state).toBe("active");
    expect(next.find("c")?.metadata.state).toBe("deleted");
  });

  it("throws on the first unknown id in bulkForget", () => {
    const manager = new MemoryManager(new MemoryRepository([makeMemory("a")]));
    expect(() => manager.bulkForget(["a", "missing"])).toThrow(MemoryNotFoundError);
  });
});

// ──────────────────────────────────────────────
//  Chained flows, determinism, scale
// ──────────────────────────────────────────────

describe("chained flows and determinism", () => {
  it("runs a full lifecycle in one immutable chain", () => {
    let manager = new MemoryManager();
    manager = manager.remember(
      makeMemoryInput("m1", { kind: "preference", tier: "short-term" }),
    ).manager;
    manager = manager.touchMemory("m1", "2026-08-02T09:00:00.000Z").manager;
    manager = manager.updateMemory("m1", { importance: "high", tier: "long-term" }).manager;
    manager = manager.archiveMemory("m1");
    const memory = manager.find("m1");
    expect(memory?.metadata.importance).toBe("high");
    expect(memory?.metadata.tier).toBe("long-term");
    expect(memory?.metadata.state).toBe("archived");
    expect(memory?.metadata.accessCount).toBe(1);
  });

  it("produces deep-equal manager states from identical operation sequences", () => {
    const run = (): MemoryManager => {
      let manager = new MemoryManager();
      manager = manager.remember(makeMemoryInput("a")).manager;
      manager = manager.remember(makeMemoryInput("b")).manager;
      manager = manager.touchMemory("a", "2026-08-02T09:00:00.000Z").manager;
      manager = manager.forget("b");
      return manager;
    };
    expect(run().list()).toEqual(run().list());
  });

  it("handles 1000 memories with correct ordering and counts", () => {
    let manager = new MemoryManager();
    for (let index = 0; index < 1000; index += 1) {
      manager = manager.remember(makeMemoryInput(`m${index}`)).manager;
    }
    expect(manager.count()).toBe(1000);
    expect(manager.list()[0].id).toBe("m0");
    expect(manager.list()[999].id).toBe("m999");
    expect(manager.forget("m500").find("m500")?.metadata.state).toBe("deleted");
  });
});
