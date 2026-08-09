import { describe, it, expect } from "vitest";
import {
  ConversationEngine,
  createProductionConversationEngine,
  type ConversationPromptOptions,
} from "@/lib/conversation/production";
import {
  createMessage,
  type ConversationMessage,
  type CreateConversationInput,
} from "@/lib/conversation/types";

// ──────────────────────────────────────────────
//  Fixtures and helpers
// ──────────────────────────────────────────────

function makeMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return createMessage({
    role: "user",
    content: "Hello",
    createdAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  });
}

function makeConversationInput(
  id: string,
  overrides: Partial<CreateConversationInput> = {},
): CreateConversationInput {
  return {
    id,
    createdAt: "2026-08-01T10:00:00.000Z",
    title: `Conversation ${id}`,
    messages: [makeMessage()],
    ...overrides,
  };
}

function makePromptOptions(overrides: Partial<ConversationPromptOptions> = {}): ConversationPromptOptions {
  return {
    userId: "user-1",
    conversationId: "c1",
    userQuery: "Continue",
    tokenBudget: 4000,
    ...overrides,
  };
}

/** Append a single turn and return the successor engine. */
function appendTurn(
  engine: ConversationEngine,
  conversationId: string,
  index: number,
  content: string,
): ConversationEngine {
  const appended = engine.appendMessage(conversationId, {
    role: index % 2 === 0 ? "user" : "assistant",
    content,
    createdAt: `2026-08-01T10:${String(index).padStart(2, "0")}:00.000Z`,
  });
  return appended.engine;
}

/** Start a conversation and append `contents`, returning the successor engine. */
function seededEngine(contents: string[], id = "c1"): ConversationEngine {
  let engine = createProductionConversationEngine();
  engine = engine.startConversation(
    makeConversationInput(id, { messages: [], createdAt: "2026-08-01T10:00:00.000Z" }),
  ).engine;
  contents.forEach((content, index) => {
    engine = appendTurn(engine, id, index, content);
  });
  return engine;
}

// ──────────────────────────────────────────────
//  New conversation
// ──────────────────────────────────────────────

describe("new conversation", () => {
  it("produces a full prompt with no conversation context when none exists", async () => {
    const engine = createProductionConversationEngine();
    const prompt = await engine.buildPrompt(
      makePromptOptions({ conversationId: undefined }),
    );
    expect(prompt).toContain("(No context available)");
    expect(prompt).toContain("================ USER ================\n\nContinue");
    expect(prompt.endsWith("================ ASSISTANT ================")).toBe(true);
  });

  it("starts a fresh conversation and includes its (empty) transcript in the next prompt", async () => {
    const engine = createProductionConversationEngine();
    const started = engine.startConversation(
      makeConversationInput("c1", { messages: [] }),
    );
    const prompt = await started.engine.buildPrompt(makePromptOptions());
    // An empty conversation still yields a context item (empty content).
    expect(prompt).toContain("Source:\nconversation");
    expect(prompt).toContain("Title:\nConversation c1");
    expect(started.engine.count()).toBe(1);
  });
});

// ──────────────────────────────────────────────
//  Continue conversation
// ──────────────────────────────────────────────

describe("continue conversation", () => {
  it("accumulates turns across appends and restores them into the prompt", async () => {
    let engine = seededEngine(["First question", "First answer"]);
    engine = appendTurn(engine, "c1", 2, "Second question");
    engine = appendTurn(engine, "c1", 3, "Second answer");

    expect(engine.getConversation("c1")?.messages).toHaveLength(4);
    const prompt = await engine.buildPrompt(makePromptOptions());
    expect(prompt).toContain("user: First question");
    expect(prompt).toContain("assistant: First answer");
    expect(prompt).toContain("user: Second question");
    expect(prompt).toContain("assistant: Second answer");
  });

  it("keeps the conversation order stable across appends", async () => {
    let engine = seededEngine(["a", "b", "c"]);
    engine = appendTurn(engine, "c1", 3, "d");
    const messages = engine.getConversation("c1")?.messages.map((m) => m.content);
    expect(messages).toEqual(["a", "b", "c", "d"]);
  });
});

// ──────────────────────────────────────────────
//  Conversation switching and multiple conversations
// ──────────────────────────────────────────────

describe("conversation switching", () => {
  it("isolates prompts per conversation", async () => {
    // A shared engine holding both conversations:
    let shared = createProductionConversationEngine();
    shared = shared.startConversation(
      makeConversationInput("a", { messages: [] }),
    ).engine;
    shared = appendTurn(shared, "a", 0, "Only in A");
    shared = shared.startConversation(
      makeConversationInput("b", { messages: [] }),
    ).engine;
    shared = appendTurn(shared, "b", 0, "Only in B");

    const promptA = await shared.buildPrompt(
      makePromptOptions({ conversationId: "a" }),
    );
    const promptB = await shared.buildPrompt(
      makePromptOptions({ conversationId: "b" }),
    );

    expect(promptA).toContain("user: Only in A");
    expect(promptA).not.toContain("Only in B");
    expect(promptB).toContain("user: Only in B");
    expect(promptB).not.toContain("Only in A");
  });
});

describe("multiple conversations", () => {
  it("tracks many conversations in insertion order", () => {
    let engine = createProductionConversationEngine();
    for (const id of ["a", "b", "c", "d"]) {
      engine = engine.startConversation(makeConversationInput(id)).engine;
    }
    expect(engine.count()).toBe(4);
    expect(engine.listConversations().map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("continues one conversation without affecting the others", async () => {
    let engine = createProductionConversationEngine();
    engine = engine.startConversation(makeConversationInput("a", { messages: [] })).engine;
    engine = engine.startConversation(makeConversationInput("b", { messages: [] })).engine;
    engine = appendTurn(engine, "a", 0, "A turn");

    expect(engine.getConversation("a")?.messages).toHaveLength(1);
    expect(engine.getConversation("b")?.messages).toHaveLength(0);

    const promptB = await engine.buildPrompt(
      makePromptOptions({ conversationId: "b" }),
    );
    // Conversation b is empty but still present — its context item is empty.
    expect(promptB).toContain("Source:\nconversation");
    expect(promptB).not.toContain("A turn");
    const promptA = await engine.buildPrompt(
      makePromptOptions({ conversationId: "a" }),
    );
    expect(promptA).toContain("user: A turn");
    expect(promptA).not.toContain("(No context available)");
  });
});

// ──────────────────────────────────────────────
//  History and context restoration
// ──────────────────────────────────────────────

describe("history and context restoration", () => {
  it("restores the full transcript into the CONTEXT section", async () => {
    const engine = seededEngine(["q1", "a1", "q2", "a2"]);
    const prompt = await engine.buildPrompt(makePromptOptions());
    expect(prompt).toContain("================ CONTEXT ================");
    expect(prompt).toContain("Source:\nconversation");
    expect(prompt).toContain("Title:\nConversation c1");
    expect(prompt).toContain("user: q1\nassistant: a1\nuser: q2\nassistant: a2");
  });

  it("restores an archived conversation into the prompt", async () => {
    let engine = seededEngine(["old turn"]);
    engine = engine.archiveConversation("c1");
    const prompt = await engine.buildPrompt(makePromptOptions());
    expect(prompt).toContain("user: old turn");
  });

  it("restores a closed (soft-deleted) conversation after reopening", async () => {
    let engine = seededEngine(["closed turn"]);
    engine = engine.closeConversation("c1");
    const closedPrompt = await engine.buildPrompt(makePromptOptions());
    expect(closedPrompt).toContain("user: closed turn");
    engine = engine.restoreConversation("c1");
    expect(engine.getConversation("c1")?.metadata.state).toBe("active");
  });
});

// ──────────────────────────────────────────────
//  Long conversations and large histories
// ──────────────────────────────────────────────

describe("long conversations", () => {
  it("handles 50 turns with full restoration within budget", async () => {
    const contents = Array.from({ length: 50 }, (_, index) => `turn ${index}`);
    const engine = seededEngine(contents);
    const prompt = await engine.buildPrompt(
      makePromptOptions({ tokenBudget: 4000 }),
    );
    expect(prompt).toContain("turn 0");
    expect(prompt).toContain("turn 49");
  });
});

describe("large histories", () => {
  it("trims a 1000-message history to the budget and keeps the recent tail", async () => {
    const contents = Array.from({ length: 1000 }, (_, index) => `bulk ${index}`);
    const engine = seededEngine(contents, "big");
    const prompt = await engine.buildPrompt(
      makePromptOptions({ conversationId: "big", tokenBudget: 100 }),
    );
    expect(prompt).toContain("bulk 999");
    expect(prompt).not.toContain("bulk 0");
    expect(prompt.length).toBeLessThan(2000);
  });

  it("restores a 1000-message history fully under a large budget", async () => {
    const contents = Array.from({ length: 1000 }, (_, index) => `bulk ${index}`);
    const engine = seededEngine(contents, "big");
    const prompt = await engine.buildPrompt(
      makePromptOptions({ conversationId: "big", tokenBudget: 100000 }),
    );
    expect(prompt).toContain("bulk 0");
    expect(prompt).toContain("bulk 999");
  });
});

// ──────────────────────────────────────────────
//  Failure isolation
// ──────────────────────────────────────────────

describe("failure isolation", () => {
  it("never throws for an unknown conversationId", async () => {
    const engine = createProductionConversationEngine();
    await expect(
      engine.buildPrompt(makePromptOptions({ conversationId: "missing" })),
    ).resolves.toContain("(No context available)");
  });

  it("never throws when appending to a closed conversation", () => {
    let engine = seededEngine(["a"]);
    engine = engine.closeConversation("c1");
    expect(() =>
      engine.appendMessage("c1", {
        role: "user",
        content: "still works",
        createdAt: "2026-08-02T09:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("keeps other conversations intact after lifecycle operations", async () => {
    let engine = createProductionConversationEngine();
    engine = engine.startConversation(makeConversationInput("a")).engine;
    engine = engine.startConversation(makeConversationInput("b")).engine;
    engine = engine.deleteConversation("a");
    expect(engine.hasConversation("a")).toBe(false);
    expect(engine.hasConversation("b")).toBe(true);
    const promptB = await engine.buildPrompt(
      makePromptOptions({ conversationId: "b" }),
    );
    expect(promptB).toContain("Conversation b");
  });
});

// ──────────────────────────────────────────────
//  Immutability
// ──────────────────────────────────────────────

describe("immutability", () => {
  it("successor engines never mutate the receiver", () => {
    const engine = createProductionConversationEngine();
    const started = engine.startConversation(makeConversationInput("c1"));
    started.engine.appendMessage("c1", {
      role: "user",
      content: "x",
      createdAt: "2026-08-01T12:00:00.000Z",
    });
    started.engine.renameConversation("c1", "X");
    started.engine.closeConversation("c1");
    started.engine.deleteConversation("c1");
    expect(engine.count()).toBe(0);
  });

  it("buildPrompt never mutates conversations or repositories", async () => {
    const engine = seededEngine(["a", "b"]);
    const before = JSON.stringify(engine.listConversations());
    await engine.buildPrompt(makePromptOptions());
    await engine.buildPrompt(makePromptOptions({ tokenBudget: 5 }));
    expect(JSON.stringify(engine.listConversations())).toBe(before);
  });
});

// ──────────────────────────────────────────────
//  Determinism
// ──────────────────────────────────────────────

describe("determinism", () => {
  it("produces identical prompts for identical histories", async () => {
    const build = async (): Promise<string> => {
      const engine = seededEngine(["alpha", "beta", "gamma"]);
      return engine.buildPrompt(makePromptOptions());
    };
    expect(await build()).toBe(await build());
  });

  it("produces identical prompts for identical large histories", async () => {
    const contents = Array.from({ length: 300 }, (_, index) => `n${index}`);
    const build = async (): Promise<string> => {
      const engine = seededEngine(contents, "big");
      return engine.buildPrompt(
        makePromptOptions({ conversationId: "big", tokenBudget: 60 }),
      );
    };
    expect(await build()).toBe(await build());
  });
});
