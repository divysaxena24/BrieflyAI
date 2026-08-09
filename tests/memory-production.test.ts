import { describe, it, expect } from "vitest";
import {
  MemoryEngine,
  MemoryEngineService,
  buildMemoryPrompt,
  createProductionMemoryEngine,
  getProductionMemoryEngine,
} from "@/lib/memory/production";
import { MemoryRepository } from "@/lib/memory/repository";
import { MemoryNotFoundError } from "@/lib/memory/repository";
import { createMemory, type CreateMemoryInput, type Memory } from "@/lib/memory/types";
import type { Conversation } from "@/lib/conversation/types";

// ──────────────────────────────────────────────
//  Fixtures
// ──────────────────────────────────────────────

function makeMemory(id: string, overrides: Partial<CreateMemoryInput> = {}): CreateMemoryInput {
  return {
    id,
    title: `Memory ${id}`,
    content: "Some content",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    tags: ["work"],
    ...overrides,
  };
}

function stored(id: string, overrides: Partial<CreateMemoryInput> = {}): Memory {
  return createMemory(makeMemory(id, overrides));
}

function seed(engine: MemoryEngine, ids: readonly string[]): MemoryEngine {
  return engine.bulkRemember(ids.map((id) => makeMemory(id))).engine;
}

// ──────────────────────────────────────────────
//  Factory and singleton
// ──────────────────────────────────────────────

describe("factory and singleton", () => {
  it("creates a fresh, independent engine per factory call", () => {
    const first = createProductionMemoryEngine();
    const second = createProductionMemoryEngine();
    expect(first).not.toBe(second);
    expect(first.count()).toBe(0);
    expect(second.count()).toBe(0);
  });

  it("seeds the engine from an injected repository", () => {
    const repository = new MemoryRepository([stored("seed")]);
    const engine = createProductionMemoryEngine(repository);
    expect(engine.count()).toBe(1);
    expect(engine.hasMemory("seed")).toBe(true);
  });

  it("returns the same singleton from getProductionMemoryEngine", () => {
    expect(getProductionMemoryEngine()).toBe(getProductionMemoryEngine());
  });
});

// ──────────────────────────────────────────────
//  Composition: reads, stores, retrieval
// ──────────────────────────────────────────────

describe("composition", () => {
  it("exposes reads over the manager's repository", () => {
    const engine = seed(createProductionMemoryEngine(), ["a", "b"]);
    expect(engine.count()).toBe(2);
    expect(engine.hasMemory("a")).toBe(true);
    expect(engine.getMemory("a")?.id).toBe("a");
    expect(engine.listMemories().map((m) => m.id)).toEqual(["a", "b"]);
    expect(engine.getMemory("missing")).toBeUndefined();
  });

  it("scopes stores to their tiers", () => {
    const engine = seed(createProductionMemoryEngine(), ["a", "b"]);
    const short = engine.shortTerm();
    expect(short.count()).toBe(2);
    const { store } = short.promote("a");
    expect(store.count()).toBe(1);
    expect(engine.longTerm().count()).toBe(0);
  });

  it("retrieves deterministically through the retriever", () => {
    let engine = seed(createProductionMemoryEngine(), ["a"]);
    engine = engine.remember(
      makeMemory("coffee", { content: "Prefers oat milk", tags: ["coffee"] }),
    ).engine;
    const hits = engine.retriever().retrieveByQuery("coffee");
    expect(hits.map((m) => m.id)).toEqual(["coffee"]);
  });
});

// ──────────────────────────────────────────────
//  Successor-engine mutations
// ──────────────────────────────────────────────

describe("successor-engine mutations", () => {
  it("returns successor engines without mutating the receiver", () => {
    const engine = createProductionMemoryEngine();
    const next = engine.remember(makeMemory("a"));
    expect(engine.count()).toBe(0);
    expect(next.engine.count()).toBe(1);
  });

  it("supports the full mutation surface", () => {
    let engine = createProductionMemoryEngine();
    engine = engine.remember(makeMemory("a")).engine;
    engine = engine.updateMemory("a", { importance: "high" }).engine;
    expect(engine.getMemory("a")?.metadata.importance).toBe("high");

    engine = engine.touchMemory("a", "2026-08-02T10:00:00.000Z").engine;
    expect(engine.getMemory("a")?.metadata.accessCount).toBe(1);

    engine = engine.archiveMemory("a");
    expect(engine.getMemory("a")?.metadata.state).toBe("archived");
    engine = engine.restoreMemory("a");
    expect(engine.getMemory("a")?.metadata.state).toBe("active");

    engine = engine.forget("a");
    expect(engine.getMemory("a")?.metadata.state).toBe("deleted");
    engine = engine.deleteMemory("a");
    expect(engine.hasMemory("a")).toBe(false);
  });

  it("bulk operations return successor engines", () => {
    const engine = createProductionMemoryEngine();
    const { engine: next, added } = engine.bulkRemember([
      makeMemory("a"),
      makeMemory("b"),
    ]);
    expect(added.map((m) => m.id)).toEqual(["a", "b"]);
    expect(next.count()).toBe(2);
    expect(engine.count()).toBe(0);

    const forgotten = next.bulkForget(["a"]);
    expect(forgotten.getMemory("a")?.metadata.state).toBe("deleted");
    expect(forgotten.getMemory("b")?.metadata.state).toBe("active");
  });

  it("propagates repository errors", () => {
    const engine = seed(createProductionMemoryEngine(), ["a"]);
    expect(() => engine.forget("missing")).toThrow(MemoryNotFoundError);
    expect(() => engine.remember(makeMemory("a"))).toThrow();
  });
});

// ──────────────────────────────────────────────
//  buildPrompt
// ──────────────────────────────────────────────

describe("buildPrompt", () => {
  it("builds a prompt with memory context through the production engine", async () => {
    let engine = createProductionMemoryEngine();
    engine = engine.remember(
      makeMemory("pref", {
        title: "Coffee preference",
        content: "The user prefers oat milk in their coffee.",
        tags: ["coffee"],
      }),
    ).engine;

    const prompt = await engine.buildPrompt({
      userId: "u1",
      userQuery: "What coffee does the user like?",
      tokenBudget: 2000,
    });

    expect(prompt).toContain("================ SYSTEM ================");
    expect(prompt).toContain("================ CONTEXT ================");
    expect(prompt).toContain("Coffee preference");
    expect(prompt).toContain("oat milk");
    expect(prompt).toContain("What coffee does the user like?");
  });

  it("renders the no-context placeholder for an empty repository", async () => {
    const prompt = await createProductionMemoryEngine().buildPrompt({
      userId: "u1",
      userQuery: "Hello",
      tokenBudget: 1000,
    });
    expect(prompt).toContain("(No context available)");
    expect(prompt).toContain("Hello");
  });

  it("forwards system prompt, history, and maxItems", async () => {
    const engine = seed(createProductionMemoryEngine(), ["a"]);
    const prompt = await engine.buildPrompt({
      userId: "u1",
      userQuery: "Hello",
      tokenBudget: 1000,
      systemPrompt: "Custom system",
      history: ["user: prior turn"],
      maxItems: 1,
    });
    expect(prompt).toContain("Custom system");
    expect(prompt).toContain("prior turn");
  });

  it("includes restored conversation context when provided", async () => {
    const conversation: Conversation = {
      id: "conv-1",
      messages: [
        { id: "m1", role: "user", content: "Remember my name is Divy", createdAt: "2026-08-01T10:00:00.000Z" },
      ],
      metadata: {
        title: "Intro",
        state: "active",
        createdAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-01T10:00:00.000Z",
      },
    };
    const engine = createProductionMemoryEngine();
    const prompt = await engine.buildPrompt({
      userId: "u1",
      userQuery: "What is my name?",
      tokenBudget: 2000,
      restoreConversation: () => [conversation],
    });
    expect(prompt).toContain("user: Remember my name is Divy");
  });

  it("never mutates the engine", async () => {
    const engine = seed(createProductionMemoryEngine(), ["a"]);
    const before = engine.listMemories();
    await engine.buildPrompt({ userId: "u1", userQuery: "q", tokenBudget: 1000 });
    expect(engine.listMemories()).toEqual(before);
  });
});

// ──────────────────────────────────────────────
//  MemoryEngineService (MemoryService contract)
// ──────────────────────────────────────────────

describe("MemoryEngineService", () => {
  it("is always available", async () => {
    const service = new MemoryEngineService();
    expect(await service.isAvailable("u1")).toBe(true);
  });

  it("returns ranked memory items with scores as relevance", async () => {
    const repository = new MemoryRepository([stored("coffee", { content: "Prefers oat milk in coffee", tags: ["coffee"] }), stored("car", { content: "Drives a red car", tags: ["car"] })]);

    const service = new MemoryEngineService(repository);
    const items = await service.retrieveRelevantMemory({
      userId: "u1",
      query: "coffee",
      maxItems: 5,
    });

    expect(items.length).toBeGreaterThan(0);
    expect(items[0].id).toBe("coffee");
    expect(items[0].relevance).toBeGreaterThan(0);
    expect(items[0].importance).toBe("normal");
    expect(items[0].timestamp).toBe("2026-08-01T10:00:00.000Z");
  });

  it("caps results by maxItems and respects a non-positive cap", async () => {
    const repository = new MemoryRepository([stored("a"), stored("b"), stored("c")]);
    const service = new MemoryEngineService(repository);
    expect((await service.retrieveRelevantMemory({ userId: "u1", query: "", maxItems: 2 })).length).toBe(2);
    expect(await service.retrieveRelevantMemory({ userId: "u1", query: "", maxItems: 0 })).toEqual([]);
  });
});

// ──────────────────────────────────────────────
//  Singleton prompt entry point
// ──────────────────────────────────────────────

describe("buildMemoryPrompt", () => {
  it("builds a prompt through the production singleton", async () => {
    const prompt = await buildMemoryPrompt({
      userId: "u1",
      userQuery: "Hi",
      tokenBudget: 1000,
    });
    expect(prompt).toContain("Hi");
    expect(prompt).toContain("================ ASSISTANT ================");
  });
});