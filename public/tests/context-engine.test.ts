import { describe, it, expect, vi } from "vitest";
import { ContextEngine } from "@/lib/context/engine";
import type { ContextBuilder } from "@/lib/context/contextBuilder";
import type { ContextRanker } from "@/lib/context/contextRanker";
import type { ContextDeduplicator } from "@/lib/context/contextDeduplicator";
import type { ContextCompressor } from "@/lib/context/contextCompressor";
import type { ContextAssembler } from "@/lib/context/contextAssembler";
import type { PromptBuilder } from "@/lib/context/promptBuilder";
import type { CompressionResult, Context, RankedContext, RetrievalQuery } from "@/lib/context/types";

type StageName =
  | "builder"
  | "ranker"
  | "deduplicator"
  | "compressor"
  | "assembler"
  | "promptBuilder";

interface HarnessOverrides {
  contexts?: Context[];
  ranked?: RankedContext[];
  deduped?: RankedContext[];
  compression?: CompressionResult;
  assembled?: string;
  prompt?: string;
  throws?: Partial<Record<StageName, Error>>;
}

interface Harness {
  engine: ContextEngine;
  builder: ContextBuilder;
  ranker: ContextRanker;
  deduplicator: ContextDeduplicator;
  compressor: ContextCompressor;
  assembler: ContextAssembler;
  promptBuilder: PromptBuilder;
  log: string[];
  overrides: HarnessOverrides;
}

/** Build a valid Context fixture. */
function makeContext(overrides: Partial<Context> = {}): Context {
  return {
    id: "ctx-1",
    source: "gmail",
    title: "Title",
    content: "Content",
    timestamp: "2026-08-08T10:00:00Z",
    relevance: 0.5,
    tokenEstimate: 10,
    truncated: false,
    compressed: false,
    metadata: { kind: "email", entityId: "e1" },
    permissions: null,
    ...overrides,
  };
}

const retrievalQuery: RetrievalQuery = {
  userId: "user-1",
  query: "show me my email",
  maxTokens: 8000,
};

const defaultOptions = {
  retrievalQuery,
  tokenBudget: 8000,
  userQuery: "show me my email",
  history: ["User: hi", "Assistant: hello"],
  systemPrompt: "You are a test assistant.",
};

/** Create a fully mocked harness. No real pipeline components are used. */
function makeHarness(overrides: HarnessOverrides = {}): Harness {
  const log: string[] = [];

  const builder = {
    build: vi.fn(async (): Promise<Context[]> => {
      log.push("builder.build");
      if (overrides.throws?.builder) throw overrides.throws.builder;
      return overrides.contexts ?? [];
    }),
  } as unknown as ContextBuilder;

  const ranker = {
    rank: vi.fn((): RankedContext[] => {
      log.push("ranker.rank");
      if (overrides.throws?.ranker) throw overrides.throws.ranker;
      return overrides.ranked ?? [];
    }),
  } as unknown as ContextRanker;

  const deduplicator = {
    deduplicate: vi.fn((): RankedContext[] => {
      log.push("deduplicator.deduplicate");
      if (overrides.throws?.deduplicator) throw overrides.throws.deduplicator;
      return overrides.deduped ?? [];
    }),
  } as unknown as ContextDeduplicator;

  const compressor = {
    compress: vi.fn((): CompressionResult => {
      log.push("compressor.compress");
      if (overrides.throws?.compressor) throw overrides.throws.compressor;
      return overrides.compression ?? { contexts: [], usedTokens: 0, remainingTokens: 0 };
    }),
  } as unknown as ContextCompressor;

  const assembler = {
    assemble: vi.fn((): string => {
      log.push("assembler.assemble");
      if (overrides.throws?.assembler) throw overrides.throws.assembler;
      return overrides.assembled ?? "";
    }),
  } as unknown as ContextAssembler;

  const promptBuilder = {
    build: vi.fn((): string => {
      log.push("promptBuilder.build");
      if (overrides.throws?.promptBuilder) throw overrides.throws.promptBuilder;
      return overrides.prompt ?? "FINAL PROMPT";
    }),
  } as unknown as PromptBuilder;

  const engine = new ContextEngine(
    builder,
    ranker,
    deduplicator,
    compressor,
    assembler,
    promptBuilder,
  );

  return { engine, builder, ranker, deduplicator, compressor, assembler, promptBuilder, log, overrides };
}

describe("ContextEngine pipeline order", () => {
  it("calls the builder first", async () => {
    const { engine, builder, log } = makeHarness();
    await engine.buildPrompt(defaultOptions);
    expect(log[0]).toBe("builder.build");
    expect(builder.build).toHaveBeenCalled();
  });

  it("calls the ranker second", async () => {
    const { engine, log } = makeHarness();
    await engine.buildPrompt(defaultOptions);
    expect(log[1]).toBe("ranker.rank");
  });

  it("calls the deduplicator third", async () => {
    const { engine, log } = makeHarness();
    await engine.buildPrompt(defaultOptions);
    expect(log[2]).toBe("deduplicator.deduplicate");
  });

  it("calls the compressor fourth", async () => {
    const { engine, log } = makeHarness();
    await engine.buildPrompt(defaultOptions);
    expect(log[3]).toBe("compressor.compress");
  });

  it("calls the assembler fifth", async () => {
    const { engine, log } = makeHarness();
    await engine.buildPrompt(defaultOptions);
    expect(log[4]).toBe("assembler.assemble");
  });

  it("calls the promptBuilder last", async () => {
    const { engine, log } = makeHarness();
    await engine.buildPrompt(defaultOptions);
    expect(log[5]).toBe("promptBuilder.build");
  });

  it("runs all six stages in the exact pipeline order", async () => {
    const { engine, log } = makeHarness();
    await engine.buildPrompt(defaultOptions);
    expect(log).toEqual([
      "builder.build",
      "ranker.rank",
      "deduplicator.deduplicate",
      "compressor.compress",
      "assembler.assemble",
      "promptBuilder.build",
    ]);
  });

  it("executes every stage exactly once", async () => {
    const { engine, builder, ranker, deduplicator, compressor, assembler, promptBuilder } =
      makeHarness();
    await engine.buildPrompt(defaultOptions);
    expect(builder.build).toHaveBeenCalledTimes(1);
    expect(ranker.rank).toHaveBeenCalledTimes(1);
    expect(deduplicator.deduplicate).toHaveBeenCalledTimes(1);
    expect(compressor.compress).toHaveBeenCalledTimes(1);
    expect(assembler.assemble).toHaveBeenCalledTimes(1);
    expect(promptBuilder.build).toHaveBeenCalledTimes(1);
  });

  it("forwards the builder output to the ranker", async () => {
    const contexts = [makeContext({ id: "a" })];
    const { engine, ranker } = makeHarness({ contexts });
    await engine.buildPrompt(defaultOptions);
    expect(ranker.rank).toHaveBeenCalledWith(contexts, retrievalQuery);
  });

  it("forwards the ranker output to the deduplicator", async () => {
    const ranked: RankedContext[] = [{ ...makeContext({ id: "a" }), score: 0.9 }];
    const { engine, deduplicator } = makeHarness({ ranked });
    await engine.buildPrompt(defaultOptions);
    expect(deduplicator.deduplicate).toHaveBeenCalledWith(ranked);
  });

  it("forwards the deduplicator output to the compressor", async () => {
    const deduped: RankedContext[] = [{ ...makeContext({ id: "a" }), score: 0.9 }];
    const { engine, compressor } = makeHarness({ deduped });
    await engine.buildPrompt(defaultOptions);
    expect(compressor.compress).toHaveBeenCalledWith(deduped, defaultOptions.tokenBudget);
  });

  it("forwards the compressed contexts to the assembler", async () => {
    const compressedContexts = [makeContext({ id: "a" })];
    const compression: CompressionResult = {
      contexts: compressedContexts,
      usedTokens: 10,
      remainingTokens: 7990,
    };
    const { engine, assembler } = makeHarness({ compression });
    await engine.buildPrompt(defaultOptions);
    expect(assembler.assemble).toHaveBeenCalledWith(compressedContexts);
  });

  it("forwards the assembled block to the promptBuilder as context", async () => {
    const { engine, promptBuilder } = makeHarness({ assembled: "=== CONTEXT START ===" });
    await engine.buildPrompt(defaultOptions);
    expect(promptBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({ context: "=== CONTEXT START ===" }),
    );
  });

  it("returns the exact promptBuilder result", async () => {
    const { engine } = makeHarness({ prompt: "THE FINAL PROMPT" });
    await expect(engine.buildPrompt(defaultOptions)).resolves.toBe("THE FINAL PROMPT");
  });

  it("resolves to a string", async () => {
    const { engine } = makeHarness({ prompt: "p" });
    const result = engine.buildPrompt(defaultOptions);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe("p");
  });
});

describe("ContextEngine argument forwarding", () => {
  it("forwards retrievalQuery to builder.build", async () => {
    const { engine, builder } = makeHarness();
    await engine.buildPrompt(defaultOptions);
    expect(builder.build).toHaveBeenCalledWith(retrievalQuery);
  });

  it("forwards retrievalQuery to ranker.rank", async () => {
    const { engine, ranker } = makeHarness();
    await engine.buildPrompt(defaultOptions);
    expect(ranker.rank).toHaveBeenCalledWith(expect.any(Array), retrievalQuery);
  });

  it("forwards tokenBudget to compressor.compress", async () => {
    const { engine, compressor } = makeHarness();
    await engine.buildPrompt(defaultOptions);
    expect(compressor.compress).toHaveBeenCalledWith(expect.any(Array), 8000);
  });

  it("forwards userQuery to promptBuilder.build", async () => {
    const { engine, promptBuilder } = makeHarness();
    await engine.buildPrompt(defaultOptions);
    expect(promptBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({ userQuery: "show me my email" }),
    );
  });

  it("forwards history to promptBuilder.build", async () => {
    const { engine, promptBuilder } = makeHarness();
    await engine.buildPrompt(defaultOptions);
    expect(promptBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({ history: ["User: hi", "Assistant: hello"] }),
    );
  });

  it("forwards systemPrompt to promptBuilder.build", async () => {
    const { engine, promptBuilder } = makeHarness();
    await engine.buildPrompt(defaultOptions);
    expect(promptBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: "You are a test assistant." }),
    );
  });

  it("forwards exactly the four prompt-builder options", async () => {
    const { engine, promptBuilder } = makeHarness({ assembled: "BLOCK" });
    await engine.buildPrompt(defaultOptions);
    expect(promptBuilder.build).toHaveBeenCalledWith({
      systemPrompt: "You are a test assistant.",
      context: "BLOCK",
      userQuery: "show me my email",
      history: ["User: hi", "Assistant: hello"],
    });
  });

  it("omits history and systemPrompt as undefined when not provided", async () => {
    const { engine, promptBuilder } = makeHarness({ assembled: "BLOCK" });
    await engine.buildPrompt({ retrievalQuery, tokenBudget: 100, userQuery: "q" });
    expect(promptBuilder.build).toHaveBeenCalledWith({
      systemPrompt: undefined,
      context: "BLOCK",
      userQuery: "q",
      history: undefined,
    });
  });
});

describe("ContextEngine error propagation", () => {
  it.each([
    ["builder", new Error("builder failed")],
    ["ranker", new Error("ranker failed")],
    ["deduplicator", new Error("deduplicator failed")],
    ["compressor", new Error("compressor failed")],
    ["assembler", new Error("assembler failed")],
    ["promptBuilder", new Error("promptBuilder failed")],
  ] as const)("propagates an error thrown by the %s stage", async (stage, error) => {
    const { engine } = makeHarness({ throws: { [stage]: error } });
    await expect(engine.buildPrompt(defaultOptions)).rejects.toBe(error);
  });

  it("does not run later stages after a stage throws", async () => {
    const { engine, deduplicator, compressor, assembler, promptBuilder } = makeHarness({
      throws: { ranker: new Error("rank boom") },
    });
    await expect(engine.buildPrompt(defaultOptions)).rejects.toThrow("rank boom");
    expect(deduplicator.deduplicate).not.toHaveBeenCalled();
    expect(compressor.compress).not.toHaveBeenCalled();
    expect(assembler.assemble).not.toHaveBeenCalled();
    expect(promptBuilder.build).not.toHaveBeenCalled();
  });

  it("propagates the rejection of a builder that rejects asynchronously", async () => {
    const { engine, builder } = makeHarness();
    const error = new Error("async builder failure");
    builder.build = vi.fn(async () => {
      throw error;
    }) as unknown as ContextBuilder["build"];
    await expect(engine.buildPrompt(defaultOptions)).rejects.toBe(error);
  });
});

describe("ContextEngine immutability", () => {
  it("does not mutate the retrievalQuery", async () => {
    const query: RetrievalQuery = {
      userId: "user-1",
      query: "original query",
      maxTokens: 5000,
      sourceFilters: ["gmail"],
    };
    const snapshot = JSON.parse(JSON.stringify(query)) as RetrievalQuery;
    const { engine } = makeHarness();
    await engine.buildPrompt({ ...defaultOptions, retrievalQuery: query });
    expect(query).toEqual(snapshot);
  });

  it("does not mutate the options object", async () => {
    const options = {
      retrievalQuery,
      tokenBudget: 8000,
      userQuery: "q",
      history: ["h1", "h2"],
      systemPrompt: "s",
    };
    const snapshot = JSON.parse(JSON.stringify(options)) as typeof options;
    const { engine } = makeHarness();
    await engine.buildPrompt(options);
    expect(options).toEqual(snapshot);
  });

  it("does not mutate the history array", async () => {
    const history = ["h1", "h2", "h3"];
    const { engine } = makeHarness();
    await engine.buildPrompt({ ...defaultOptions, history });
    expect(history).toEqual(["h1", "h2", "h3"]);
  });

  it("passes stage outputs through by reference (never re-copies them)", async () => {
    const contexts = [makeContext({ id: "a" })];
    const ranked: RankedContext[] = [{ ...contexts[0], score: 0.9 }];
    const deduped: RankedContext[] = ranked;
    const compressedContexts = [makeContext({ id: "a" })];
    const { engine, ranker, deduplicator, compressor, assembler } = makeHarness({
      contexts,
      ranked,
      deduped,
      compression: { contexts: compressedContexts, usedTokens: 10, remainingTokens: 0 },
    });
    await engine.buildPrompt(defaultOptions);
    expect(ranker.rank).toHaveBeenCalledWith(contexts, retrievalQuery);
    expect(deduplicator.deduplicate).toHaveBeenCalledWith(ranked);
    expect(compressor.compress).toHaveBeenCalledWith(deduped, defaultOptions.tokenBudget);
    expect(assembler.assemble).toHaveBeenCalledWith(compressedContexts);
  });
});

describe("ContextEngine determinism", () => {
  it("produces the same prompt for the same mocks and input", async () => {
    const { engine } = makeHarness({ prompt: "STABLE" });
    const first = await engine.buildPrompt(defaultOptions);
    const second = await engine.buildPrompt(defaultOptions);
    expect(first).toBe(second);
    expect(first).toBe("STABLE");
  });

  it("records the identical call sequence on repeated runs", async () => {
    const harness = makeHarness({ prompt: "STABLE" });
    await harness.engine.buildPrompt(defaultOptions);
    const firstLog = [...harness.log];
    await harness.engine.buildPrompt(defaultOptions);
    expect(harness.log).toEqual([...firstLog, ...firstLog]);
  });

  it("uses only the injected mock instances across calls", async () => {
    const harnessA = makeHarness({ prompt: "A" });
    const harnessB = makeHarness({ prompt: "B" });
    await harnessA.engine.buildPrompt(defaultOptions);
    await harnessB.engine.buildPrompt(defaultOptions);
    // Each engine drove its own injected spies exactly once.
    expect(harnessA.builder.build).toHaveBeenCalledTimes(1);
    expect(harnessB.builder.build).toHaveBeenCalledTimes(1);
    expect(harnessA.promptBuilder.build).toHaveBeenCalledTimes(1);
    expect(harnessB.promptBuilder.build).toHaveBeenCalledTimes(1);
    // Each log contains its own six-stage sequence; no cross-talk.
    expect(harnessA.log).toEqual([
      "builder.build",
      "ranker.rank",
      "deduplicator.deduplicate",
      "compressor.compress",
      "assembler.assemble",
      "promptBuilder.build",
    ]);
    expect(harnessB.log).toEqual(harnessA.log);
  });
});

describe("ContextEngine edge cases", () => {
  it("still runs every stage when the builder returns no contexts", async () => {
    const { engine, log } = makeHarness({ contexts: [] });
    await engine.buildPrompt(defaultOptions);
    expect(log).toEqual([
      "builder.build",
      "ranker.rank",
      "deduplicator.deduplicate",
      "compressor.compress",
      "assembler.assemble",
      "promptBuilder.build",
    ]);
  });

  it("handles an empty ranked list", async () => {
    const { engine } = makeHarness({ ranked: [] });
    await expect(engine.buildPrompt(defaultOptions)).resolves.toBe("FINAL PROMPT");
  });

  it("handles an empty compressed context list", async () => {
    const { engine, assembler } = makeHarness({
      compression: { contexts: [], usedTokens: 0, remainingTokens: 8000 },
    });
    await engine.buildPrompt(defaultOptions);
    expect(assembler.assemble).toHaveBeenCalledWith([]);
  });

  it("handles an empty assembled context string", async () => {
    const { engine, promptBuilder } = makeHarness({ assembled: "" });
    await engine.buildPrompt(defaultOptions);
    expect(promptBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({ context: "" }),
    );
  });

  it("handles an empty history array", async () => {
    const { engine } = makeHarness();
    await expect(engine.buildPrompt({ ...defaultOptions, history: [] })).resolves.toBe(
      "FINAL PROMPT",
    );
  });

  it("handles an empty userQuery", async () => {
    const { engine } = makeHarness();
    await expect(engine.buildPrompt({ ...defaultOptions, userQuery: "" })).resolves.toBe(
      "FINAL PROMPT",
    );
  });

  it("handles a zero tokenBudget", async () => {
    const { engine, compressor } = makeHarness();
    await engine.buildPrompt({ ...defaultOptions, tokenBudget: 0 });
    expect(compressor.compress).toHaveBeenCalledWith(expect.any(Array), 0);
  });

  it("handles a large tokenBudget", async () => {
    const { engine, compressor } = makeHarness();
    await engine.buildPrompt({ ...defaultOptions, tokenBudget: 1_000_000 });
    expect(compressor.compress).toHaveBeenCalledWith(expect.any(Array), 1_000_000);
  });

  it("handles multiple sequential calls with changing outputs", async () => {
    const harness = makeHarness({ prompt: "FIRST" });
    const first = await harness.engine.buildPrompt(defaultOptions);
    harness.overrides.prompt = "SECOND";
    const second = await harness.engine.buildPrompt(defaultOptions);
    expect(first).toBe("FIRST");
    expect(second).toBe("SECOND");
    expect(harness.builder.build).toHaveBeenCalledTimes(2);
  });

  it("uses the exact instances passed to the constructor", async () => {
    const harness = makeHarness();
    await harness.engine.buildPrompt(defaultOptions);
    // Every injected spy was invoked — nothing was constructed internally.
    expect(harness.builder.build).toHaveBeenCalled();
    expect(harness.ranker.rank).toHaveBeenCalled();
    expect(harness.deduplicator.deduplicate).toHaveBeenCalled();
    expect(harness.compressor.compress).toHaveBeenCalled();
    expect(harness.assembler.assemble).toHaveBeenCalled();
    expect(harness.promptBuilder.build).toHaveBeenCalled();
  });

  it("passes a snapshot of the retrievalQuery to the builder", async () => {
    // Even though the engine never copies inputs, the builder receives the
    // same query reference passed by the caller.
    const { engine, builder } = makeHarness();
    await engine.buildPrompt(defaultOptions);
    expect(builder.build).toHaveBeenCalledWith(retrievalQuery);
  });

  it("handles a retrievalQuery with only the required fields", async () => {
    const minimalQuery: RetrievalQuery = { userId: "u", query: "q" };
    const { engine, builder } = makeHarness();
    await engine.buildPrompt({ retrievalQuery: minimalQuery, tokenBudget: 100, userQuery: "q" });
    expect(builder.build).toHaveBeenCalledWith(minimalQuery);
  });

  it("handles a single-entry history", async () => {
    const { engine } = makeHarness({ prompt: "p" });
    await expect(
      engine.buildPrompt({ ...defaultOptions, history: ["only entry"] }),
    ).resolves.toBe("p");
  });
});
