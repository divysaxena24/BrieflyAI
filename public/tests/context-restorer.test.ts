import { describe, it, expect } from "vitest";
import {
  conversationToContext,
  conversationToContexts,
  ConversationContextSource,
  CONVERSATION_SOURCE_ID,
  CONVERSATION_SOURCE_PRIORITY,
  DEFAULT_CONVERSATION_RELEVANCE,
} from "@/lib/conversation/contextRestorer";
import {
  createConversation,
  createMessage,
  type Conversation,
  type ConversationMessage,
} from "@/lib/conversation/types";
import { estimateTokens } from "@/lib/context/tokenBudget";
import type { Context, RetrievalQuery } from "@/lib/context/types";
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

function makeMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return createMessage({
    role: "user",
    content: "Hello",
    createdAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  });
}

function makeConversation(
  id: string,
  messages: readonly ConversationMessage[] = [makeMessage()],
): Conversation {
  return createConversation({
    id,
    createdAt: "2026-08-01T10:00:00.000Z",
    title: `Conversation ${id}`,
    messages,
  });
}

function makeDialogue(id: string, count: number): Conversation {
  const messages = Array.from({ length: count }, (_, index) =>
    makeMessage({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      createdAt: `2026-08-01T10:00:${String(index).padStart(2, "0")}.000Z`,
    }),
  );
  return makeConversation(id, messages);
}

function makeQuery(overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return { userId: "user-1", query: "project status", ...overrides };
}

/** A real ContextEngine wired with a conversation source (integration). */
function makeConversationEngine(source: ConversationContextSource): ContextEngine {
  return new ContextEngine(
    new ContextBuilder([source]),
    new ContextRanker(),
    new ContextDeduplicator(),
    new ContextCompressor(),
    new ContextAssembler(),
    new PromptBuilder(),
  );
}

// ──────────────────────────────────────────────
//  conversion
// ──────────────────────────────────────────────

describe("conversion", () => {
  it("maps a conversation to a full Context object", () => {
    const conversation = makeConversation("c1", [
      makeMessage({ role: "user", content: "Hello", createdAt: "2026-08-01T10:00:00.000Z" }),
      makeMessage({
        role: "assistant",
        content: "Hi there",
        createdAt: "2026-08-01T10:01:00.000Z",
      }),
    ]);
    const context = conversationToContext(conversation);

    expect(context.id).toBe("c1");
    expect(context.source).toBe(CONVERSATION_SOURCE_ID);
    expect(context.title).toBe("Conversation c1");
    expect(context.content).toBe("user: Hello\nassistant: Hi there");
    expect(context.timestamp).toBe("2026-08-01T10:01:00.000Z");
    expect(context.relevance).toBe(DEFAULT_CONVERSATION_RELEVANCE);
    expect(context.tokenEstimate).toBe(estimateTokens("user: Hello\nassistant: Hi there"));
    expect(context.truncated).toBe(false);
    expect(context.compressed).toBe(false);
    expect(context.permissions).toBeNull();
  });

  it("sets conversation metadata (kind, entityId, conversationId)", () => {
    const context = conversationToContext(makeConversation("c1"));
    expect(context.metadata.kind).toBe("conversation");
    expect(context.metadata.entityId).toBe("c1");
    expect(context.metadata.conversationId).toBe("c1");
  });

  it("uses the conversation title when present", () => {
    const conversation = createConversation({
      id: "c1",
      createdAt: "2026-08-01T10:00:00.000Z",
      title: "Weekly recap",
      messages: [],
    });
    expect(conversationToContext(conversation).title).toBe("Weekly recap");
  });

  it("carries importance, url, and relevance options", () => {
    const context = conversationToContext(makeConversation("c1"), {
      importance: "high",
      url: "https://app.example.com/conversations/c1",
      relevance: 0.9,
    });
    expect(context.metadata.importance).toBe("high");
    expect(context.metadata.url).toBe("https://app.example.com/conversations/c1");
    expect(context.relevance).toBe(0.9);
  });

  it("renders an empty content for an empty conversation", () => {
    const context = conversationToContext(makeConversation("c1", []));
    expect(context.content).toBe("");
    expect(context.tokenEstimate).toBe(0);
  });

  it("caps the transcript to the most recent maxMessages", () => {
    const conversation = makeDialogue("c1", 5);
    const context = conversationToContext(conversation, { maxMessages: 2 });
    // messages 0..4 alternate user/assistant, so the tail is assistant 3, user 4.
    expect(context.content).toBe("assistant: message 3\nuser: message 4");
  });

  it("renders an empty transcript for a non-positive maxMessages", () => {
    const conversation = makeDialogue("c1", 5);
    expect(conversationToContext(conversation, { maxMessages: 0 }).content).toBe("");
    expect(conversationToContext(conversation, { maxMessages: -3 }).content).toBe("");
  });

  it("renders role prefixes for every role", () => {
    const conversation = makeConversation("c1", [
      makeMessage({ role: "system", content: "sys" }),
      makeMessage({ role: "user", content: "usr" }),
      makeMessage({ role: "assistant", content: "ast" }),
      makeMessage({ role: "tool", content: "tl" }),
    ]);
    expect(conversationToContext(conversation).content).toBe(
      "system: sys\nuser: usr\nassistant: ast\ntool: tl",
    );
  });
});

// ──────────────────────────────────────────────
//  Ordering
// ──────────────────────────────────────────────

describe("ordering", () => {
  it("renders the transcript oldest first", () => {
    const conversation = makeDialogue("c1", 4);
    const lines = conversationToContext(conversation).content.split("\n");
    expect(lines[0]).toBe("user: message 0");
    expect(lines[3]).toBe("assistant: message 3");
  });

  it("conversationToContexts preserves input order", () => {
    const contexts = conversationToContexts([
      makeConversation("a"),
      makeConversation("b"),
      makeConversation("c"),
    ]);
    expect(contexts.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("conversationToContexts returns [] for empty input", () => {
    expect(conversationToContexts([])).toEqual([]);
  });
});

// ──────────────────────────────────────────────
//  Empty and large histories
// ──────────────────────────────────────────────

describe("history sizes", () => {
  it("handles an empty conversation", () => {
    const context = conversationToContext(makeConversation("c1", []));
    expect(context.content).toBe("");
    expect(context.tokenEstimate).toBe(0);
    expect(context.timestamp).toBe("2026-08-01T10:00:00.000Z");
  });

  it("handles a 1000-message conversation with full ordering", () => {
    const conversation = makeDialogue("big", 1000);
    const context = conversationToContext(conversation);
    const lines = context.content.split("\n");
    expect(lines).toHaveLength(1000);
    expect(lines[0]).toBe("user: message 0");
    expect(lines[999]).toBe("assistant: message 999");
  });

  it("caps a large history with maxMessages", () => {
    const conversation = makeDialogue("big", 1000);
    const context = conversationToContext(conversation, { maxMessages: 50 });
    const lines = context.content.split("\n");
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("user: message 950");
    expect(lines[49]).toBe("assistant: message 999");
  });
});

// ──────────────────────────────────────────────
//  ConversationContextSource
// ──────────────────────────────────────────────

describe("ConversationContextSource", () => {
  it("exposes the conversation source id and priority", () => {
    const source = new ConversationContextSource(() => []);
    expect(source.id).toBe(CONVERSATION_SOURCE_ID);
    expect(source.priority).toBe(CONVERSATION_SOURCE_PRIORITY);
  });

  it("is always available", async () => {
    const source = new ConversationContextSource(() => []);
    expect(await source.isAvailable("user-1")).toBe(true);
  });

  it("retrieves the restored conversations as contexts", async () => {
    const conversations = [makeConversation("a"), makeConversation("b")];
    const source = new ConversationContextSource(() => conversations);
    const contexts = await source.retrieve(makeQuery());
    expect(contexts.map((c) => c.id)).toEqual(["a", "b"]);
    expect(contexts.every((c) => c.source === CONVERSATION_SOURCE_ID)).toBe(true);
  });

  it("returns [] when the restore function yields nothing", async () => {
    const source = new ConversationContextSource(() => []);
    expect(await source.retrieve(makeQuery())).toEqual([]);
  });

  it("forwards the query to the restore function", async () => {
    let received: RetrievalQuery | undefined;
    const source = new ConversationContextSource((query) => {
      received = query;
      return [];
    });
    await source.retrieve(makeQuery({ query: "hello", maxItems: 5 }));
    expect(received?.query).toBe("hello");
    expect(received?.userId).toBe("user-1");
    expect(received?.maxItems).toBe(5);
  });
});

// ──────────────────────────────────────────────
//  Integration with the Context Engine
// ──────────────────────────────────────────────

describe("integration with the Context Engine", () => {
  it("feeds restored conversations through the full pipeline into a prompt", async () => {
    const conversation = makeDialogue("c1", 4);
    const source = new ConversationContextSource(() => [conversation]);
    const engine = makeConversationEngine(source);

    const prompt = await engine.buildPrompt({
      retrievalQuery: makeQuery(),
      tokenBudget: 4000,
      userQuery: "What did we discuss?",
    });

    expect(prompt).toContain("================ SYSTEM ================");
    expect(prompt).toContain("================ CONTEXT ================");
    expect(prompt).toContain("================ USER ================");
    expect(prompt).toContain("================ ASSISTANT ================");
    expect(prompt).toContain("Source:\nconversation");
    expect(prompt).toContain("user: message 0");
    expect(prompt).toContain("assistant: message 3");
    expect(prompt).toContain("What did we discuss?");
  });

  it("renders the no-context placeholder for an empty restoration", async () => {
    const source = new ConversationContextSource(() => []);
    const engine = makeConversationEngine(source);
    const prompt = await engine.buildPrompt({
      retrievalQuery: makeQuery(),
      tokenBudget: 4000,
      userQuery: "Hello",
    });
    expect(prompt).toContain("(No context available)");
  });

  it("compresses an over-budget conversation deterministically", async () => {
    const conversation = makeDialogue("big", 500);
    const source = new ConversationContextSource(() => [conversation]);
    const engine = makeConversationEngine(source);

    const prompt = await engine.buildPrompt({
      retrievalQuery: makeQuery(),
      tokenBudget: 40,
      userQuery: "q",
    });

    expect(prompt).toContain("...[truncated]...");
    expect(prompt.length).toBeLessThan(2000);
  });
});

// ──────────────────────────────────────────────
//  Immutability and determinism
// ──────────────────────────────────────────────

describe("immutability and determinism", () => {
  it("never mutates the input conversation", () => {
    const conversation = makeDialogue("c1", 3);
    const snapshot = JSON.stringify(conversation);
    conversationToContext(conversation);
    conversationToContexts([conversation]);
    expect(JSON.stringify(conversation)).toBe(snapshot);
  });

  it("returns fresh objects that share no references with the input", () => {
    const conversation = makeDialogue("c1", 2);
    const context = conversationToContext(conversation);
    expect(context).not.toBe(conversation);
    expect(context.metadata).not.toBe(conversation.metadata as unknown);
    // Mutating the context never affects the conversation.
    (context as unknown as { title: string }).title = "Mutated";
    expect(conversation.metadata.title).toBe("Conversation c1");
  });

  it("produces deep-equal contexts from identical inputs", () => {
    const conversation = makeDialogue("c1", 3);
    expect(conversationToContext(conversation)).toEqual(conversationToContext(conversation));
  });

  it("source retrieval never mutates the restore function's conversations", async () => {
    const conversation = makeDialogue("c1", 2);
    const snapshot = JSON.stringify(conversation);
    const source = new ConversationContextSource(() => [conversation]);
    const contexts = (await source.retrieve(makeQuery())) as Context[];
    (contexts[0] as unknown as { content: string }).content = "Changed";
    expect(JSON.stringify(conversation)).toBe(snapshot);
  });
});
