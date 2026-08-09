import { describe, it, expect } from "vitest";
import {
  DEFAULT_MEMORY_CONTEXT_ITEMS,
  MemoryContextSource,
  memoryToContext,
  memoryToContexts,
} from "@/lib/memory/context";
import { MemoryRepository } from "@/lib/memory/repository";
import { createMemory, type CreateMemoryInput, type Memory } from "@/lib/memory/types";
import { ContextEngine } from "@/lib/context/engine";
import { ContextBuilder } from "@/lib/context/contextBuilder";
import { ContextRanker } from "@/lib/context/contextRanker";
import { ContextDeduplicator } from "@/lib/context/contextDeduplicator";
import { ContextCompressor } from "@/lib/context/contextCompressor";
import { ContextAssembler } from "@/lib/context/contextAssembler";
import { PromptBuilder } from "@/lib/context/promptBuilder";
import { MEMORY_SOURCE_ID } from "@/lib/context/sources/memorySource";

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

// ──────────────────────────────────────────────
//  memoryToContext
// ──────────────────────────────────────────────

describe("memoryToContext", () => {
  it("converts a memory to a memory-kind Context item", () => {
    const memory = makeMemory("m1", {
      title: "Coffee preference",
      content: "Prefers oat milk.",
      importance: "high",
      tags: ["coffee"],
      conversationId: "conv-1",
    });
    const context = memoryToContext(memory, 0.8);

    expect(context.id).toBe("m1");
    expect(context.source).toBe(MEMORY_SOURCE_ID);
    expect(context.title).toBe("Coffee preference");
    expect(context.content).toBe("Prefers oat milk.");
    expect(context.timestamp).toBe("2026-08-01T10:00:00.000Z");
    expect(context.relevance).toBe(0.8);
    expect(context.tokenEstimate).toBeGreaterThan(0);
    expect(context.truncated).toBe(false);
    expect(context.compressed).toBe(false);
    expect(context.permissions).toBeNull();
    expect(context.metadata.kind).toBe("memory");
    expect(context.metadata.entityId).toBe("m1");
    expect(context.metadata.conversationId).toBe("conv-1");
    expect(context.metadata.importance).toBe("high");
  });

  it("defaults relevance to DEFAULT_MEMORY_RELEVANCE and clamps out-of-range values", () => {
    expect(memoryToContext(makeMemory("m1")).relevance).toBe(0.5);
    expect(memoryToContext(makeMemory("m1"), 2).relevance).toBe(1);
    expect(memoryToContext(makeMemory("m1"), -1).relevance).toBe(0);
  });

  it("does not carry a conversationId when the memory has none", () => {
    const context = memoryToContext(makeMemory("m1"));
    expect(context.metadata.conversationId).toBeUndefined();
  });

  it("never mutates the input", () => {
    const memory = makeMemory("m1", { tags: ["work"] });
    memoryToContext(memory);
    expect(memory.metadata.tags).toEqual(["work"]);
  });
});

// ──────────────────────────────────────────────
//  memoryToContexts
// ──────────────────────────────────────────────

describe("memoryToContexts", () => {
  it("converts every memory in order", () => {
    const contexts = memoryToContexts([makeMemory("a"), makeMemory("b")]);
    expect(contexts.map((context) => context.id)).toEqual(["a", "b"]);
  });

  it("accepts a per-memory relevance function", () => {
    const contexts = memoryToContexts([makeMemory("a"), makeMemory("b")], (memory) =>
      memory.id === "a" ? 0.9 : 0.1,
    );
    expect(contexts[0].relevance).toBe(0.9);
    expect(contexts[1].relevance).toBe(0.1);
  });

  it("returns [] for empty input", () => {
    expect(memoryToContexts([])).toEqual([]);
  });
});

// ──────────────────────────────────────────────
//  MemoryContextSource
// ──────────────────────────────────────────────

describe("MemoryContextSource", () => {
  it("is a memory-id source with the memory priority", () => {
    const source = new MemoryContextSource(new MemoryRepository());
    expect(source.id).toBe(MEMORY_SOURCE_ID);
    expect(source.priority).toBe(100);
  });

  it("is always available", async () => {
    const source = new MemoryContextSource(new MemoryRepository());
    expect(await source.isAvailable("u1")).toBe(true);
  });

  it("ranks repository memories against the query and caps by maxItems", async () => {
    const repository = new MemoryRepository([
      makeMemory("coffee", { title: "Coffee", content: "Prefers oat milk in coffee" }),
      makeMemory("car", { title: "Car", content: "Drives a red car" }),
    ]);
    const source = new MemoryContextSource(repository);

    const contexts = await source.retrieve({
      userId: "u1",
      query: "coffee",
      maxItems: 5,
    });

    // Every memory is ranked (semantic signal is one of several signals);
    // the query-matching memory must rank first with a positive score.
    expect(contexts[0].id).toBe("coffee");
    expect(contexts[0].relevance).toBeGreaterThan(0);
    expect(contexts.map((context) => context.id)).toHaveLength(2);
  });

  it("ranks deterministically for an empty query and respects maxItems", async () => {
    const repository = new MemoryRepository([makeMemory("a"), makeMemory("b")]);
    const source = new MemoryContextSource(repository);
    const contexts = await source.retrieve({ userId: "u1", query: "", maxItems: 1 });
    expect(contexts).toHaveLength(1);
    expect(source.id).toBe(MEMORY_SOURCE_ID);
  });

  it("returns [] for a non-positive maxItems", async () => {
    const repository = new MemoryRepository([makeMemory("a")]);
    const source = new MemoryContextSource(repository);
    expect(await source.retrieve({ userId: "u1", query: "a", maxItems: 0 })).toEqual([]);
  });

  it("defaults the cap to DEFAULT_MEMORY_CONTEXT_ITEMS", async () => {
    const many = Array.from({ length: 25 }, (_, index) => makeMemory(`m${index}`));
    const source = new MemoryContextSource(new MemoryRepository(many));
    const contexts = await source.retrieve({ userId: "u1", query: "" });
    expect(contexts).toHaveLength(DEFAULT_MEMORY_CONTEXT_ITEMS);
  });

  it("never mutates the repository", async () => {
    const repository = new MemoryRepository([makeMemory("a")]);
    const source = new MemoryContextSource(repository);
    await source.retrieve({ userId: "u1", query: "a" });
    expect(repository.count()).toBe(1);
  });
});

// ──────────────────────────────────────────────
//  Pipeline integration
// ──────────────────────────────────────────────

describe("pipeline integration", () => {
  it("feeds memory context through the full Context Engine to a prompt", async () => {
    const repository = new MemoryRepository([
      makeMemory("coffee", {
        title: "Coffee preference",
        content: "The user prefers oat milk in their coffee.",
        importance: "high",
        tags: ["coffee"],
      }),
    ]);
    const engine = new ContextEngine(
      new ContextBuilder([new MemoryContextSource(repository)]),
      new ContextRanker(),
      new ContextDeduplicator(),
      new ContextCompressor(),
      new ContextAssembler(),
      new PromptBuilder(),
    );

    const prompt = await engine.buildPrompt({
      retrievalQuery: { userId: "u1", query: "coffee" },
      tokenBudget: 2000,
      userQuery: "What does the user drink?",
    });

    expect(prompt).toContain("=== CONTEXT START ===");
    expect(prompt).toContain("Coffee preference");
    expect(prompt).toContain("oat milk");
    expect(prompt).toContain("What does the user drink?");
  });

  it("renders the assembler placeholder when the repository is empty", async () => {
    const engine = new ContextEngine(
      new ContextBuilder([new MemoryContextSource(new MemoryRepository())]),
      new ContextRanker(),
      new ContextDeduplicator(),
      new ContextCompressor(),
      new ContextAssembler(),
      new PromptBuilder(),
    );

    const prompt = await engine.buildPrompt({
      retrievalQuery: { userId: "u1", query: "anything" },
      tokenBudget: 1000,
      userQuery: "Hello",
    });

    expect(prompt).toContain("(No context available)");
  });
});
