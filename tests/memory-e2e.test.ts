import { describe, it, expect } from "vitest";
import {
  MemoryEngineService,
  createProductionMemoryEngine,
  getProductionMemoryEngine,
} from "@/lib/memory/production";
import { MemoryRepository } from "@/lib/memory/repository";
import { MemoryContextSource, memoryToContext } from "@/lib/memory/context";
import { rankMemories } from "@/lib/memory/ranker";
import { MemoryRetriever } from "@/lib/memory/retrieval";
import { createMemory, type CreateMemoryInput, type Memory } from "@/lib/memory/types";
import { ContextEngine } from "@/lib/context/engine";
import { ContextBuilder } from "@/lib/context/contextBuilder";
import { ContextRanker } from "@/lib/context/contextRanker";
import { ContextDeduplicator } from "@/lib/context/contextDeduplicator";
import { ContextCompressor } from "@/lib/context/contextCompressor";
import { ContextAssembler } from "@/lib/context/contextAssembler";
import { PromptBuilder } from "@/lib/context/promptBuilder";

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

/** The full memory pipeline: remember → retrieve → rank → context → prompt. */
async function runPipeline(
  memories: readonly Memory[],
  query: string,
): Promise<{ prompt: string; contexts: ReturnType<typeof memoryToContext>[] }> {
  const repository = new MemoryRepository(memories);
  const engine = new ContextEngine(
    new ContextBuilder([new MemoryContextSource(repository)]),
    new ContextRanker(),
    new ContextDeduplicator(),
    new ContextCompressor(),
    new ContextAssembler(),
    new PromptBuilder(),
  );
  const prompt = await engine.buildPrompt({
    retrievalQuery: { userId: "u1", query },
    tokenBudget: 4000,
    userQuery: query,
  });
  return { prompt, contexts: [] };
}

// ──────────────────────────────────────────────
//  Full flow: remember → retrieve → rank → context → prompt
// ──────────────────────────────────────────────

describe("full flow", () => {
  it("remembers, retrieves, ranks, and renders memories into the final prompt", async () => {
    let engine = createProductionMemoryEngine();
    engine = engine.remember(
      makeMemory("coffee", {
        title: "Coffee preference",
        content: "The user prefers oat milk in their coffee.",
        importance: "high",
        tags: ["coffee"],
      }),
    ).engine;
    engine = engine.remember(
      makeMemory("car", {
        title: "Car",
        content: "The user drives a red car.",
        importance: "normal",
        tags: ["car"],
      }),
    ).engine;

    // 1. retrieve
    const hits = engine.retriever().retrieveByQuery("coffee");
    expect(hits.map((memory) => memory.id)).toEqual(["coffee"]);

    // 2. rank
    const ranked = rankMemories(engine.listMemories(), "coffee");
    expect(ranked[0].id).toBe("coffee");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);

    // 3. context conversion + Context Engine + prompt builder
    const { prompt } = await runPipeline(engine.listMemories(), "coffee");
    expect(prompt).toContain("Coffee preference");
    expect(prompt).toContain("oat milk");
    expect(prompt).toContain("================ ASSISTANT ================");
  });

  it("links memories to conversations and boosts them during ranking", async () => {
    let engine = createProductionMemoryEngine();
    engine = engine.remember(
      makeMemory("conv-mem", {
        title: "Conversation fact",
        content: "Discussed the project timeline.",
        conversationId: "conv-1",
        tags: ["project"],
      }),
    ).engine;
    engine = engine.remember(
      makeMemory("plain", { title: "Plain", content: "Unrelated note.", tags: ["note"] }),
    ).engine;

    const linked = engine.retriever().retrieveByConversation("conv-1");
    expect(linked.map((memory) => memory.id)).toEqual(["conv-mem"]);

    const boosted = rankMemories(engine.listMemories(), "timeline", {
      conversationId: "conv-1",
    });
    expect(boosted[0].id).toBe("conv-mem");
  });

  it("surfaces recent memories through the retriever window", async () => {
    let engine = createProductionMemoryEngine();
    for (let index = 0; index < 5; index += 1) {
      engine = engine.remember(
        makeMemory(`m${index}`, { updatedAt: `2026-08-0${index + 1}T10:00:00.000Z` }),
      ).engine;
    }
    const window = engine.retriever().retrieveWindow(2);
    expect(window.memories).toHaveLength(2);
    expect(window.total).toBe(5);
    expect(window.trimmed).toBe(3);
    expect(window.memories[0].id).toBe("m4");
  });

  it("retrieves by importance through the production engine", async () => {
    let engine = createProductionMemoryEngine();
    engine = engine.remember(makeMemory("crit", { importance: "critical" })).engine;
    engine = engine.remember(makeMemory("low", { importance: "low" })).engine;
    expect(engine.retriever().retrieveImportant("critical").map((memory) => memory.id)).toEqual([
      "crit",
    ]);
  });
});

// ──────────────────────────────────────────────
//  Production engine
// ──────────────────────────────────────────────

describe("production engine", () => {
  it("builds prompts through the singleton", async () => {
    const engine = getProductionMemoryEngine();
    const prompt = await engine.buildPrompt({
      userId: "u1",
      userQuery: "Hello",
      tokenBudget: 1000,
    });
    expect(prompt).toContain("Hello");
  });

  it("exposes a MemoryService satisfying the Context Engine contract", async () => {
    const repository = new MemoryRepository([
      createMemory(makeMemory("coffee", { content: "Prefers oat milk in coffee" })),
    ]);
    const service = new MemoryEngineService(repository);
    expect(await service.isAvailable("u1")).toBe(true);
    const items = await service.retrieveRelevantMemory({ userId: "u1", query: "coffee" });
    expect(items[0].id).toBe("coffee");
    expect(items[0].relevance).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────
//  Large datasets (1000 memories)
// ──────────────────────────────────────────────

describe("large datasets", () => {
  it("handles 1000 memories through remember, rank, and prompt", async () => {
    let engine = createProductionMemoryEngine();
    const inputs: CreateMemoryInput[] = Array.from({ length: 1000 }, (_, index) =>
      makeMemory(`mem-${index}`, {
        title: `Memory ${index}`,
        content: `Memorized fact number ${index} about the project`,
        createdAt: `2026-08-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
        updatedAt: `2026-08-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
        tags: [index % 2 === 0 ? "even" : "odd"],
      }),
    );
    engine = engine.bulkRemember(inputs).engine;
    expect(engine.count()).toBe(1000);

    const ranked = rankMemories(engine.listMemories(), "fact 7");
    expect(ranked).toHaveLength(1000);
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[999].score);

    const { prompt } = await runPipeline(engine.listMemories(), "fact 7");
    expect(prompt).toContain("=== CONTEXT START ===");
  });

  it("scales retrieval over 1000 memories", () => {
    const repository = new MemoryRepository(
      Array.from({ length: 1000 }, (_, index) =>
        createMemory(
          makeMemory(`m${index}`, { content: `Data point ${index} for search` }),
        ),
      ),
    );
    const retriever = new MemoryRetriever(repository);
    expect(retriever.retrieveByQuery("search").length).toBe(1000);
    expect(retriever.retrieveWindow(10).memories).toHaveLength(10);
    expect(retriever.retrieveRecent(5)).toHaveLength(5);
  });
});

// ──────────────────────────────────────────────
//  Determinism and immutability
// ──────────────────────────────────────────────

describe("determinism and immutability", () => {
  it("produces identical prompts from identical states", async () => {
    const memories = [
      createMemory(makeMemory("a", { content: "Apple facts" })),
      createMemory(makeMemory("b", { content: "Banana facts" })),
    ];
    const first = await runPipeline(memories, "facts");
    const second = await runPipeline(memories, "facts");
    expect(first.prompt).toBe(second.prompt);
  });

  it("never mutates engine state through the pipeline", async () => {
    let engine = createProductionMemoryEngine();
    engine = engine.remember(makeMemory("a")).engine;
    const before = engine.listMemories();
    await engine.buildPrompt({ userId: "u1", userQuery: "q", tokenBudget: 1000 });
    await engine.retriever().retrieveByQuery("q");
    rankMemories(engine.listMemories(), "q");
    expect(engine.listMemories()).toEqual(before);
  });

  it("keeps successors detached from their receivers", async () => {
    const engine = createProductionMemoryEngine();
    const { engine: next } = engine.remember(makeMemory("a"));
    expect(engine.count()).toBe(0);
    expect(next.count()).toBe(1);
  });
});

// ──────────────────────────────────────────────
//  Failure isolation
// ──────────────────────────────────────────────

describe("failure isolation", () => {
  it("returns [] for a throwing memory source without failing the pipeline", async () => {
    const failingSource = {
      id: "memory",
      priority: 100,
      async isAvailable(): Promise<boolean> {
        return true;
      },
      async retrieve(): Promise<never> {
        throw new Error("boom");
      },
    };
    const engine = new ContextEngine(
      new ContextBuilder([failingSource]),
      new ContextRanker(),
      new ContextDeduplicator(),
      new ContextCompressor(),
      new ContextAssembler(),
      new PromptBuilder(),
    );
    const prompt = await engine.buildPrompt({
      retrievalQuery: { userId: "u1", query: "q" },
      tokenBudget: 1000,
      userQuery: "Hello",
    });
    expect(prompt).toContain("(No context available)");
  });

  it("propagates repository errors to the caller", () => {
    const engine = createProductionMemoryEngine();
    expect(() => engine.forget("missing")).toThrow();
  });
});
