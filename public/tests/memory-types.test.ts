import { describe, it, expect } from "vitest";
import {
  createMemory,
  cloneMemory,
  freezeMemory,
  estimateMemoryTokens,
  createMemorySummary,
  touchMemory,
  isExpired,
  DEFAULT_MEMORY_KIND,
  DEFAULT_MEMORY_SOURCE,
  DEFAULT_MEMORY_IMPORTANCE,
  DEFAULT_MEMORY_TIER,
  DEFAULT_MEMORY_STATE,
  type Memory,
  type MemoryKind,
  type MemorySource,
  type MemoryImportance,
  type MemoryTier,
  type MemoryState,
  type MemorySearchResult,
  type MemoryReference,
} from "@/lib/memory/types";
import { estimateTokens } from "@/lib/context/tokenBudget";

// ──────────────────────────────────────────────
//  Fixtures
// ──────────────────────────────────────────────

function makeMemory(overrides: Partial<Parameters<typeof createMemory>[0]> = {}): Memory {
  return createMemory({
    title: "Remember this",
    content: "The user prefers concise summaries.",
    createdAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  });
}

// ──────────────────────────────────────────────
//  Construction
// ──────────────────────────────────────────────

describe("createMemory", () => {
  it("builds a memory with the given fields and a derived id", () => {
    const memory = createMemory({
      title: "T",
      content: "C",
      createdAt: "2026-08-01T10:00:00.000Z",
    });
    expect(memory.metadata.title).toBe("T");
    expect(memory.content).toBe("C");
    expect(memory.id).toMatch(/^mem-[0-9a-f]{8}$/);
  });

  it("applies defaults (kind knowledge, source user, importance normal, tier short-term, state active)", () => {
    const memory = makeMemory();
    expect(memory.metadata.kind).toBe(DEFAULT_MEMORY_KIND);
    expect(memory.metadata.source).toBe(DEFAULT_MEMORY_SOURCE);
    expect(memory.metadata.importance).toBe(DEFAULT_MEMORY_IMPORTANCE);
    expect(memory.metadata.tier).toBe(DEFAULT_MEMORY_TIER);
    expect(memory.metadata.state).toBe(DEFAULT_MEMORY_STATE);
    expect(memory.metadata.accessCount).toBe(0);
    expect(memory.metadata.lastAccessedAt).toBeNull();
    expect(memory.metadata.tags).toEqual([]);
  });

  it("derives a deterministic id from kind, title, content, and createdAt", () => {
    const input = {
      title: "T",
      content: "C",
      createdAt: "2026-08-01T10:00:00.000Z",
    };
    expect(createMemory(input).id).toBe(createMemory(input).id);
  });

  it("derives different ids for different contents", () => {
    const a = createMemory({ title: "T", content: "A", createdAt: "t" });
    const b = createMemory({ title: "T", content: "B", createdAt: "t" });
    expect(a.id).not.toBe(b.id);
  });

  it("honors an explicit id", () => {
    expect(createMemory({ title: "T", content: "C", createdAt: "t", id: "custom-1" }).id).toBe(
      "custom-1",
    );
  });

  it("defaults updatedAt to createdAt", () => {
    const memory = createMemory({ title: "T", content: "C", createdAt: "2026-08-01T10:00:00.000Z" });
    expect(memory.metadata.updatedAt).toBe("2026-08-01T10:00:00.000Z");
  });

  it("honors an explicit updatedAt", () => {
    const memory = createMemory({
      title: "T",
      content: "C",
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-02T10:00:00.000Z",
    });
    expect(memory.metadata.updatedAt).toBe("2026-08-02T10:00:00.000Z");
  });

  it("carries kind, source, importance, tier, state, tags, conversationId, expiresAt", () => {
    const memory = createMemory({
      title: "T",
      content: "C",
      createdAt: "2026-08-01T10:00:00.000Z",
      kind: "preference",
      source: "assistant",
      importance: "high",
      tier: "long-term",
      state: "archived",
      tags: ["work"],
      conversationId: "conv-1",
      expiresAt: "2026-09-01T00:00:00.000Z",
    });
    expect(memory.metadata.kind).toBe("preference");
    expect(memory.metadata.source).toBe("assistant");
    expect(memory.metadata.importance).toBe("high");
    expect(memory.metadata.tier).toBe("long-term");
    expect(memory.metadata.state).toBe("archived");
    expect(memory.metadata.tags).toEqual(["work"]);
    expect(memory.metadata.conversationId).toBe("conv-1");
    expect(memory.metadata.expiresAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("copies tags and extra instead of referencing them", () => {
    const tags = ["a"];
    const extra = { source: "gmail" };
    const memory = createMemory({
      title: "T",
      content: "C",
      createdAt: "t",
      tags,
      extra,
    });
    tags.push("b");
    extra.source = "changed";
    expect(memory.metadata.tags).toEqual(["a"]);
    expect(memory.extra).toEqual({ source: "gmail" });
  });

  it("accepts every memory kind, source, importance, tier, and state", () => {
    const kinds: MemoryKind[] = ["fact", "preference", "task", "knowledge", "conversation", "context"];
    const sources: MemorySource[] = ["user", "assistant", "system", "tool", "derived"];
    const importances: MemoryImportance[] = ["low", "normal", "high", "critical"];
    const tiers: MemoryTier[] = ["short-term", "long-term"];
    const states: MemoryState[] = ["active", "archived", "deleted"];
    for (const kind of kinds) {
      expect(createMemory({ title: "T", content: "C", createdAt: "t", kind }).metadata.kind).toBe(kind);
    }
    for (const source of sources) {
      expect(
        createMemory({ title: "T", content: "C", createdAt: "t", source }).metadata.source,
      ).toBe(source);
    }
    for (const importance of importances) {
      expect(
        createMemory({ title: "T", content: "C", createdAt: "t", importance }).metadata.importance,
      ).toBe(importance);
    }
    for (const tier of tiers) {
      expect(createMemory({ title: "T", content: "C", createdAt: "t", tier }).metadata.tier).toBe(tier);
    }
    for (const state of states) {
      expect(
        createMemory({ title: "T", content: "C", createdAt: "t", state }).metadata.state,
      ).toBe(state);
    }
  });
});

// ──────────────────────────────────────────────
//  Readonly models (compile-time guards)
// ──────────────────────────────────────────────

describe("readonly models", () => {
  it("memory fields are readonly (compile-time)", () => {
    const memory = makeMemory();
    // @ts-expect-error — content is readonly on Memory
    memory.content = "mutated";
  });

  it("metadata fields are readonly (compile-time)", () => {
    const memory = makeMemory();
    // @ts-expect-error — title is readonly on MemoryMetadata
    memory.metadata.title = "mutated";
    // @ts-expect-error — tags is a readonly array
    memory.metadata.tags.push("x");
  });

  it("constructs a MemorySearchResult and a MemoryReference", () => {
    const result: MemorySearchResult = { ...makeMemory(), score: 0.75 };
    const reference: MemoryReference = { memoryId: "mem-1", conversationId: "conv-1" };
    expect(result.score).toBe(0.75);
    expect(reference.memoryId).toBe("mem-1");
    expect(reference.conversationId).toBe("conv-1");
  });
});

// ──────────────────────────────────────────────
//  Token estimation
// ──────────────────────────────────────────────

describe("estimateMemoryTokens", () => {
  it("matches the shared estimateTokens heuristic on content", () => {
    const memory = makeMemory();
    expect(estimateMemoryTokens(memory)).toBe(estimateTokens(memory.content));
    expect(estimateMemoryTokens(memory)).toBe(Math.ceil(memory.content.length / 4));
  });

  it("returns 0 for an empty content", () => {
    expect(estimateMemoryTokens(makeMemory({ content: "" }))).toBe(0);
  });

  it("is deterministic across calls", () => {
    const memory = makeMemory();
    expect(estimateMemoryTokens(memory)).toBe(estimateMemoryTokens(memory));
  });
});

// ──────────────────────────────────────────────
//  Summary
// ──────────────────────────────────────────────

describe("createMemorySummary", () => {
  it("projects the core fields and token estimate", () => {
    const memory = makeMemory({
      kind: "preference",
      importance: "high",
      tier: "long-term",
      updatedAt: "2026-08-02T09:00:00.000Z",
    });
    const summary = createMemorySummary(memory);
    expect(summary.id).toBe(memory.id);
    expect(summary.title).toBe("Remember this");
    expect(summary.kind).toBe("preference");
    expect(summary.importance).toBe("high");
    expect(summary.tier).toBe("long-term");
    expect(summary.updatedAt).toBe("2026-08-02T09:00:00.000Z");
    expect(summary.tokenEstimate).toBe(estimateMemoryTokens(memory));
  });

  it("includes a preview for non-empty content and omits it for empty content", () => {
    const withContent = createMemorySummary(makeMemory());
    expect(withContent.preview).toBe("The user prefers concise summaries.");
    const without = createMemorySummary(makeMemory({ content: "" }));
    expect(without.preview).toBeUndefined();
  });

  it("truncates long previews to 80 characters", () => {
    const memory = makeMemory({ content: "x".repeat(200) });
    expect(createMemorySummary(memory).preview).toBe("x".repeat(80));
  });
});

// ──────────────────────────────────────────────
//  touchMemory
// ──────────────────────────────────────────────

describe("touchMemory", () => {
  it("updates lastAccessedAt and increments accessCount", () => {
    const memory = makeMemory();
    const touched = touchMemory(memory, "2026-08-03T10:00:00.000Z");
    expect(touched.metadata.lastAccessedAt).toBe("2026-08-03T10:00:00.000Z");
    expect(touched.metadata.accessCount).toBe(1);
    expect(memory.metadata.accessCount).toBe(0);
    expect(memory.metadata.lastAccessedAt).toBeNull();
  });

  it("accumulates across touches", () => {
    let memory = makeMemory();
    memory = touchMemory(memory, "2026-08-03T10:00:00.000Z");
    memory = touchMemory(memory, "2026-08-04T10:00:00.000Z");
    expect(memory.metadata.accessCount).toBe(2);
    expect(memory.metadata.lastAccessedAt).toBe("2026-08-04T10:00:00.000Z");
  });

  it("does not change updatedAt (access is not a modification)", () => {
    const memory = makeMemory({ updatedAt: "2026-08-02T09:00:00.000Z" });
    const touched = touchMemory(memory, "2026-08-03T10:00:00.000Z");
    expect(touched.metadata.updatedAt).toBe("2026-08-02T09:00:00.000Z");
  });

  it("preserves every other field and is detached", () => {
    const memory = makeMemory({ tags: ["a"] });
    const touched = touchMemory(memory, "2026-08-03T10:00:00.000Z");
    expect(touched.metadata.tags).toEqual(["a"]);
    expect(touched.metadata.title).toBe(memory.metadata.title);
    expect(touched).not.toBe(memory);
    expect(touched.metadata).not.toBe(memory.metadata);
  });
});

// ──────────────────────────────────────────────
//  isExpired
// ──────────────────────────────────────────────

describe("isExpired", () => {
  it("never expires without expiresAt", () => {
    expect(isExpired(makeMemory(), "2099-01-01T00:00:00.000Z")).toBe(false);
  });

  it("expires at or after the expiry timestamp", () => {
    const memory = makeMemory({ expiresAt: "2026-08-10T00:00:00.000Z" });
    expect(isExpired(memory, "2026-08-09T23:59:59.000Z")).toBe(false);
    expect(isExpired(memory, "2026-08-10T00:00:00.000Z")).toBe(true);
    expect(isExpired(memory, "2026-08-11T00:00:00.000Z")).toBe(true);
  });

  it("is deterministic", () => {
    const memory = makeMemory({ expiresAt: "2026-08-10T00:00:00.000Z" });
    expect(isExpired(memory, "2026-08-11T00:00:00.000Z")).toBe(
      isExpired(memory, "2026-08-11T00:00:00.000Z"),
    );
  });
});

// ──────────────────────────────────────────────
//  Freezing
// ──────────────────────────────────────────────

describe("freezeMemory", () => {
  it("returns the same reference (in-place freeze)", () => {
    const memory = makeMemory();
    expect(freezeMemory(memory)).toBe(memory);
  });

  it("freezes metadata, tags, and extra", () => {
    const memory = makeMemory({ tags: ["a"], extra: { k: 1 } });
    freezeMemory(memory);
    expect(Object.isFrozen(memory)).toBe(true);
    expect(Object.isFrozen(memory.metadata)).toBe(true);
    expect(Object.isFrozen(memory.metadata.tags)).toBe(true);
    expect(Object.isFrozen(memory.extra)).toBe(true);
  });

  it("blocks assignment in strict mode", () => {
    const memory = freezeMemory(makeMemory());
    expect(() => {
      (memory as unknown as { content: string }).content = "changed";
    }).toThrow();
    expect(() => {
      (memory.metadata as unknown as { title: string }).title = "changed";
    }).toThrow();
    expect(() => {
      (memory.metadata.tags as unknown as string[]).push("x");
    }).toThrow();
  });

  it("is idempotent", () => {
    const memory = freezeMemory(makeMemory());
    expect(freezeMemory(memory)).toBe(memory);
    expect(Object.isFrozen(memory)).toBe(true);
  });
});

// ──────────────────────────────────────────────
//  Cloning
// ──────────────────────────────────────────────

describe("cloneMemory", () => {
  it("returns a new object, not the same reference", () => {
    const memory = makeMemory();
    expect(cloneMemory(memory)).not.toBe(memory);
  });

  it("deep-equals the source", () => {
    const memory = makeMemory({ tags: ["a"], extra: { k: 1 }, conversationId: "c" });
    expect(cloneMemory(memory)).toEqual(memory);
  });

  it("detaches every nested object", () => {
    const memory = makeMemory({ tags: ["a"], extra: { k: 1 } });
    const clone = cloneMemory(memory);
    expect(clone.metadata).not.toBe(memory.metadata);
    expect(clone.metadata.tags).not.toBe(memory.metadata.tags);
    expect(clone.extra).not.toBe(memory.extra);
  });

  it("mutating the clone does not affect the source", () => {
    const memory = makeMemory();
    const clone = cloneMemory(memory);
    clone.metadata.tags.push("x");
    (clone.metadata as unknown as { title: string }).title = "Changed";
    (clone as unknown as { content: string }).content = "Changed";
    expect(memory.metadata.tags).toEqual([]);
    expect(memory.metadata.title).toBe("Remember this");
    expect(memory.content).toBe("The user prefers concise summaries.");
  });

  it("clones a frozen memory into a fresh unfrozen copy", () => {
    const memory = freezeMemory(makeMemory());
    const clone = cloneMemory(memory);
    expect(clone).toEqual(memory);
    expect(Object.isFrozen(clone)).toBe(false);
    expect(Object.isFrozen(clone.metadata)).toBe(false);
  });
});

// ──────────────────────────────────────────────
//  Determinism and scale
// ──────────────────────────────────────────────

describe("determinism and scale", () => {
  it("builds deep-equal memories from identical inputs", () => {
    const input = {
      title: "T",
      content: "C",
      createdAt: "2026-08-01T10:00:00.000Z",
      tags: ["a"],
      kind: "fact" as const,
    };
    expect(createMemory(input)).toEqual(createMemory(input));
  });

  it("clones deep-equal memories from identical sources", () => {
    const source = makeMemory();
    expect(cloneMemory(source)).toEqual(cloneMemory(source));
  });

  it("handles a 1000-memory dataset for build, estimate, clone, freeze", () => {
    const memories: Memory[] = Array.from({ length: 1000 }, (_, index) =>
      makeMemory({
        id: `mem-${index}`,
        title: `Memory ${index}`,
        content: `content ${index}`,
        tags: [`tag-${index % 10}`],
      }),
    );
    expect(memories).toHaveLength(1000);
    expect(estimateMemoryTokens(memories[999])).toBe(estimateTokens("content 999"));
    const clone = cloneMemory(memories[500]);
    expect(clone).toEqual(memories[500]);
    expect(clone).not.toBe(memories[500]);
    freezeMemory(memories[0]);
    expect(Object.isFrozen(memories[0].metadata.tags)).toBe(true);
  });
});
