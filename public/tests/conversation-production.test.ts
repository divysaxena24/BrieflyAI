import { describe, it, expect } from "vitest";
import {
  ConversationEngine,
  createProductionConversationEngine,
  getProductionConversationEngine,
  buildConversationPrompt,
  type ConversationPromptOptions,
} from "@/lib/conversation/production";
import { ConversationRepository } from "@/lib/conversation/repository";
import {
  createConversation,
  createMessage,
  type Conversation,
  type ConversationMessage,
  type CreateConversationInput,
} from "@/lib/conversation/types";

// ──────────────────────────────────────────────
//  Fixtures
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

function makeConversation(
  id: string,
  overrides: Partial<CreateConversationInput> = {},
): Conversation {
  return createConversation(makeConversationInput(id, overrides));
}

function makePromptOptions(overrides: Partial<ConversationPromptOptions> = {}): ConversationPromptOptions {
  return {
    userId: "user-1",
    conversationId: "c1",
    userQuery: "What is the status?",
    tokenBudget: 4000,
    ...overrides,
  };
}

/** Build a conversation with the given message contents (user/assistant alternating). */
function seedEngine(engine: ConversationEngine, id: string, contents: string[]): ConversationEngine {
  let current = engine.startConversation(
    makeConversationInput(id, { messages: [], createdAt: "2026-08-01T10:00:00.000Z" }),
  ).engine;
  contents.forEach((content, index) => {
    const appended = current.appendMessage(id, {
      role: index % 2 === 0 ? "user" : "assistant",
      content,
      createdAt: `2026-08-01T10:0${index}:00.000Z`,
    });
    current = appended.engine;
  });
  return current;
}

// ──────────────────────────────────────────────
//  Factory and singleton
// ──────────────────────────────────────────────

describe("production factory and singleton", () => {
  it("builds a ConversationEngine", () => {
    expect(createProductionConversationEngine()).toBeInstanceOf(ConversationEngine);
  });

  it("returns fresh independent engines from the factory", () => {
    const a = createProductionConversationEngine();
    const b = createProductionConversationEngine();
    expect(a).not.toBe(b);
    expect(a).not.toBe(getProductionConversationEngine());
  });

  it("returns the same singleton from getProductionConversationEngine", () => {
    expect(getProductionConversationEngine()).toBe(getProductionConversationEngine());
  });

  it("builds an empty engine by default", () => {
    expect(createProductionConversationEngine().count()).toBe(0);
  });

  it("seeds conversations via an injected repository (DI)", () => {
    const repository = new ConversationRepository([makeConversation("seed-1")]);
    const engine = createProductionConversationEngine(repository);
    expect(engine.count()).toBe(1);
    expect(engine.getConversation("seed-1")?.metadata.title).toBe("Conversation seed-1");
  });
});

// ──────────────────────────────────────────────
//  Composition (conversation operations)
// ──────────────────────────────────────────────

describe("composition — conversation operations", () => {
  it("start and append flow through the manager", () => {
    const engine = createProductionConversationEngine();
    const started = engine.startConversation(
      makeConversationInput("c1", { messages: [] }),
    );
    expect(started.engine.count()).toBe(1);
    expect(engine.count()).toBe(0); // receiver unchanged

    const appended = started.engine.appendMessage("c1", {
      role: "user",
      content: "Hello",
      createdAt: "2026-08-01T11:00:00.000Z",
    });
    expect(appended.engine.getConversation("c1")?.messages).toHaveLength(1);
    expect(appended.engine.getConversation("c1")?.metadata.updatedAt).toBe(
      "2026-08-01T11:00:00.000Z",
    );
  });

  it("supports the full lifecycle chain", () => {
    let engine = createProductionConversationEngine();
    engine = engine.startConversation(makeConversationInput("c1")).engine;
    engine = engine.renameConversation("c1", "Weekly");
    engine = engine.closeConversation("c1");
    expect(engine.getConversation("c1")?.metadata.state).toBe("deleted");
    engine = engine.restoreConversation("c1");
    expect(engine.getConversation("c1")?.metadata.state).toBe("active");
    engine = engine.archiveConversation("c1");
    engine = engine.deleteConversation("c1");
    expect(engine.count()).toBe(0);
  });
});

// ──────────────────────────────────────────────
//  Prompt generation — new conversation
// ──────────────────────────────────────────────

describe("prompt generation — new conversation", () => {
  it("renders the full prompt structure with no conversation context", async () => {
    const engine = createProductionConversationEngine();
    const prompt = await engine.buildPrompt(
      makePromptOptions({ conversationId: undefined }),
    );
    expect(prompt).toContain("================ SYSTEM ================");
    expect(prompt).toContain("================ HISTORY ================");
    expect(prompt).toContain("================ CONTEXT ================");
    expect(prompt).toContain("================ USER ================\n\nWhat is the status?");
    expect(prompt.endsWith("================ ASSISTANT ================")).toBe(true);
    expect(prompt).toContain("(No context available)");
  });
});

// ──────────────────────────────────────────────
//  Prompt generation — conversation restoration
// ──────────────────────────────────────────────

describe("prompt generation — conversation restoration", () => {
  it("restores the conversation transcript into the prompt", async () => {
    const engine = seedEngine(
      createProductionConversationEngine(),
      "c1",
      ["First user turn", "First assistant turn"],
    );
    const prompt = await engine.buildPrompt(makePromptOptions());
    expect(prompt).toContain("user: First user turn");
    expect(prompt).toContain("assistant: First assistant turn");
    expect(prompt).toContain("Source:\nconversation");
    expect(prompt).toContain("What is the status?");
  });

  it("treats an unknown conversationId as an empty restoration (no throw)", async () => {
    const engine = createProductionConversationEngine();
    const prompt = await engine.buildPrompt(
      makePromptOptions({ conversationId: "missing" }),
    );
    expect(prompt).toContain("(No context available)");
  });

  it("forwards systemPrompt and history into the prompt", async () => {
    const engine = seedEngine(
      createProductionConversationEngine(),
      "c1",
      ["turn"],
    );
    const prompt = await engine.buildPrompt(
      makePromptOptions({
        systemPrompt: "You are a test assistant.",
        history: ["User: earlier", "Assistant: earlier reply"],
      }),
    );
    expect(prompt).toContain("================ SYSTEM ================\n\nYou are a test assistant.");
    expect(prompt).toContain("================ HISTORY ================\n\nUser: earlier\nAssistant: earlier reply");
  });

  it("does not mutate the conversation or repository when building a prompt", async () => {
    const engine = seedEngine(
      createProductionConversationEngine(),
      "c1",
      ["turn 1", "turn 2"],
    );
    const before = JSON.stringify(engine.listConversations());
    await engine.buildPrompt(makePromptOptions());
    expect(JSON.stringify(engine.listConversations())).toBe(before);
    expect(engine.getConversation("c1")?.messages).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────
//  Integration — large and long conversations
// ──────────────────────────────────────────────

describe("integration — long conversations", () => {
  it("summarizes an over-budget conversation deterministically", async () => {
    const contents = Array.from({ length: 100 }, (_, index) => `message ${index}`);
    const engine = seedEngine(createProductionConversationEngine(), "c1", contents);
    const prompt = await engine.buildPrompt(
      makePromptOptions({ tokenBudget: 40 }),
    );
    // The deterministic summarizer trims the transcript to the budget before
    // the Context Engine, so only the most recent messages survive.
    expect(prompt).toContain("message 99");
    expect(prompt).not.toContain("message 0");
    expect(prompt.length).toBeLessThan(4000);
  });

  it("keeps a within-budget conversation intact in the prompt", async () => {
    const engine = seedEngine(
      createProductionConversationEngine(),
      "c1",
      ["short a", "short b"],
    );
    const prompt = await engine.buildPrompt(
      makePromptOptions({ tokenBudget: 4000 }),
    );
    expect(prompt).toContain("user: short a");
    expect(prompt).toContain("assistant: short b");
  });

  it("handles 1000 messages across many conversations", async () => {
    let engine = createProductionConversationEngine();
    const contents = Array.from({ length: 1000 }, (_, index) => `bulk ${index}`);
    engine = seedEngine(engine, "bulk", contents);
    expect(engine.getConversation("bulk")?.messages).toHaveLength(1000);
    const prompt = await engine.buildPrompt(
      makePromptOptions({ conversationId: "bulk", tokenBudget: 2000 }),
    );
    expect(prompt).toContain("bulk 999");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────
//  Determinism and immutability
// ──────────────────────────────────────────────

describe("determinism and immutability", () => {
  it("produces identical prompts from identical states", async () => {
    const build = async (): Promise<string> => {
      const engine = seedEngine(
        createProductionConversationEngine(),
        "c1",
        ["a", "b", "c"],
      );
      return engine.buildPrompt(makePromptOptions());
    };
    expect(await build()).toBe(await build());
  });

  it("successor engines never mutate the receiver", async () => {
    const engine = createProductionConversationEngine();
    const started = engine.startConversation(makeConversationInput("c1"));
    started.engine.appendMessage("c1", {
      role: "user",
      content: "x",
      createdAt: "2026-08-01T12:00:00.000Z",
    });
    started.engine.renameConversation("c1", "X");
    started.engine.closeConversation("c1");
    expect(engine.count()).toBe(0);
  });
});

// ──────────────────────────────────────────────
//  buildConversationPrompt (singleton entry point)
// ──────────────────────────────────────────────

describe("buildConversationPrompt", () => {
  it("builds a full prompt through the production singleton", async () => {
    const prompt = await buildConversationPrompt({
      userId: "user-1",
      userQuery: "status?",
      tokenBudget: 4000,
    });
    expect(prompt).toContain("================ SYSTEM ================");
    expect(prompt).toContain("================ CONTEXT ================");
    expect(prompt).toContain("================ USER ================\n\nstatus?");
    expect(prompt.endsWith("================ ASSISTANT ================")).toBe(true);
    expect(prompt).toContain("(No context available)");
  });

  it("never sees successor state through the singleton (immutability)", () => {
    const singleton = getProductionConversationEngine();
    const started = singleton.startConversation(makeConversationInput("iso-1"));
    expect(started.engine.count()).toBe(1);
    expect(singleton.count()).toBe(0);
  });
});
