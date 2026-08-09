import { describe, it, expect } from "vitest";
import {
  createConversation,
  createMessage,
  cloneConversation,
  freezeConversation,
  estimateConversationTokens,
  MESSAGE_OVERHEAD_TOKENS,
  type Conversation,
  type ConversationMessage,
  type ConversationMetadata,
  type ConversationRole,
  type ConversationState,
  type ConversationSummary,
  type MessageReference,
} from "@/lib/conversation/types";
import { estimateTokens } from "@/lib/context/tokenBudget";

// ──────────────────────────────────────────────
//  Fixtures
// ──────────────────────────────────────────────

/** Build a message via the pure factory. */
function makeMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return createMessage({
    role: "user",
    content: "Hello",
    createdAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  });
}

/** Build a conversation via the pure factory. */
function makeConversation(
  overrides: Partial<Parameters<typeof createConversation>[0]> = {},
): Conversation {
  return createConversation({
    id: "conv-1",
    createdAt: "2026-08-01T10:00:00.000Z",
    messages: [makeMessage(), makeMessage({ role: "assistant", content: "Hi there!" })],
    ...overrides,
  });
}

const EMPTY_MESSAGE_TOKENS = MESSAGE_OVERHEAD_TOKENS + estimateTokens("Hello");

// ──────────────────────────────────────────────
//  Construction
// ──────────────────────────────────────────────

describe("createMessage", () => {
  it("builds a message with the given fields and a derived id", () => {
    const message = createMessage({ role: "user", content: "Hello", createdAt: "2026-08-01T10:00:00.000Z" });
    expect(message.role).toBe("user");
    expect(message.content).toBe("Hello");
    expect(message.createdAt).toBe("2026-08-01T10:00:00.000Z");
    expect(message.id).toMatch(/^msg-[0-9a-f]{8}$/);
  });

  it("derives a deterministic id from role, content, and createdAt", () => {
    const input = { role: "user" as const, content: "Hello", createdAt: "2026-08-01T10:00:00.000Z" };
    expect(createMessage(input).id).toBe(createMessage(input).id);
  });

  it("derives different ids for different content", () => {
    const a = createMessage({ role: "user", content: "Hello", createdAt: "2026-08-01T10:00:00.000Z" });
    const b = createMessage({ role: "user", content: "World", createdAt: "2026-08-01T10:00:00.000Z" });
    expect(a.id).not.toBe(b.id);
  });

  it("honors an explicit id", () => {
    expect(createMessage({ role: "user", content: "x", createdAt: "t", id: "custom-1" }).id).toBe("custom-1");
  });

  it("accepts every conversation role", () => {
    const roles: ConversationRole[] = ["user", "assistant", "system", "tool"];
    for (const role of roles) {
      expect(createMessage({ role, content: "x", createdAt: "t" }).role).toBe(role);
    }
  });

  it("copies metadata instead of referencing it", () => {
    const metadata = { source: "gmail" };
    const message = createMessage({ role: "user", content: "x", createdAt: "t", metadata });
    metadata.source = "changed";
    expect(message.metadata).toEqual({ source: "gmail" });
  });
});

describe("createConversation", () => {
  it("builds a conversation with defaults (state active, empty tags)", () => {
    const conversation = createConversation({ id: "c", createdAt: "2026-08-01T10:00:00.000Z" });
    expect(conversation.id).toBe("c");
    expect(conversation.metadata.state).toBe("active");
    expect(conversation.metadata.tags).toEqual([]);
    expect(conversation.messages).toEqual([]);
  });

  it("carries title, state, tags, and messages through", () => {
    const message = makeMessage();
    const conversation = createConversation({
      id: "c",
      createdAt: "2026-08-01T10:00:00.000Z",
      title: "Project sync",
      state: "archived",
      tags: ["work", "project"],
      messages: [message],
    });
    expect(conversation.metadata.title).toBe("Project sync");
    expect(conversation.metadata.state).toBe("archived");
    expect(conversation.metadata.tags).toEqual(["work", "project"]);
    expect(conversation.messages).toHaveLength(1);
  });

  it("omits title when not provided", () => {
    const conversation = createConversation({ id: "c", createdAt: "2026-08-01T10:00:00.000Z" });
    expect("title" in conversation.metadata).toBe(false);
  });

  it("computes updatedAt as the latest message createdAt", () => {
    const conversation = makeConversation({
      createdAt: "2026-08-01T10:00:00.000Z",
      messages: [
        makeMessage({ createdAt: "2026-08-01T10:00:00.000Z" }),
        makeMessage({ role: "assistant", createdAt: "2026-08-02T09:00:00.000Z" }),
      ],
    });
    expect(conversation.metadata.updatedAt).toBe("2026-08-02T09:00:00.000Z");
  });

  it("sets updatedAt to createdAt for an empty conversation", () => {
    const conversation = createConversation({ id: "c", createdAt: "2026-08-01T10:00:00.000Z" });
    expect(conversation.metadata.updatedAt).toBe("2026-08-01T10:00:00.000Z");
  });

  it("detaches the messages array from the caller", () => {
    const messages = [makeMessage()];
    const conversation = createConversation({ id: "c", createdAt: "2026-08-01T10:00:00.000Z", messages });
    messages.push(makeMessage());
    expect(conversation.messages).toHaveLength(1);
  });

  it("detaches each message from the caller", () => {
    const message = makeMessage();
    const conversation = createConversation({ id: "c", createdAt: "2026-08-01T10:00:00.000Z", messages: [message] });
    expect(conversation.messages[0]).not.toBe(message);
    expect(conversation.messages[0]).toEqual(message);
  });

  it("detaches the tags array from the caller", () => {
    const tags = ["work"];
    const conversation = createConversation({ id: "c", createdAt: "2026-08-01T10:00:00.000Z", tags });
    tags.push("extra");
    expect(conversation.metadata.tags).toEqual(["work"]);
  });
});

// ──────────────────────────────────────────────
//  Readonly (compile-time guards + runtime state)
// ──────────────────────────────────────────────

describe("readonly models", () => {
  it("message fields are readonly (compile-time)", () => {
    const message = makeMessage();
    // @ts-expect-error — content is readonly on ConversationMessage
    message.content = "mutated";
  });

  it("conversation messages array is readonly (compile-time)", () => {
    const conversation = makeConversation();
    // @ts-expect-error — messages is a readonly array on Conversation
    conversation.messages.push(makeMessage());
  });

  it("role and state accept only their union members (compile-time)", () => {
    const role: ConversationRole = "assistant";
    const state: ConversationState = "deleted";
    // @ts-expect-error — "admin" is not a ConversationRole
    const badRole: ConversationRole = "admin";
    // @ts-expect-error — "closed" is not a ConversationState
    const badState: ConversationState = "closed";
    void badRole;
    void badState;
    expect(role).toBe("assistant");
    expect(state).toBe("deleted");
  });

  it("factories return unfrozen objects; freezeConversation freezes them", () => {
    const conversation = makeConversation();
    expect(Object.isFrozen(conversation)).toBe(false);
    expect(Object.isFrozen(conversation.messages)).toBe(false);
    expect(Object.isFrozen(conversation.messages[0])).toBe(false);
    freezeConversation(conversation);
    expect(Object.isFrozen(conversation)).toBe(true);
    expect(Object.isFrozen(conversation.metadata)).toBe(true);
    expect(Object.isFrozen(conversation.messages)).toBe(true);
    expect(Object.isFrozen(conversation.messages[0])).toBe(true);
  });
});

// ──────────────────────────────────────────────
//  Metadata and summary/reference shapes
// ──────────────────────────────────────────────

describe("conversation metadata", () => {
  it("carries the full metadata shape", () => {
    const conversation = makeConversation({ title: "T", tags: ["a"] });
    const metadata: ConversationMetadata = conversation.metadata;
    expect(metadata.createdAt).toBe("2026-08-01T10:00:00.000Z");
    expect(metadata.updatedAt).toBe("2026-08-01T10:00:00.000Z");
    expect(metadata.state).toBe("active");
    expect(metadata.title).toBe("T");
    expect(metadata.tags).toEqual(["a"]);
  });

  it("preserves message metadata", () => {
    const message = makeMessage({ metadata: { toolCallId: "call-1" } });
    expect(message.metadata).toEqual({ toolCallId: "call-1" });
  });
});

describe("summary and reference shapes", () => {
  it("constructs a ConversationSummary", () => {
    const summary: ConversationSummary = {
      id: "conv-1",
      title: "Project sync",
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-02T09:00:00.000Z",
      messageCount: 12,
      state: "active",
      preview: "Let's sync on the roadmap.",
    };
    expect(summary.messageCount).toBe(12);
    expect(summary.state).toBe("active");
  });

  it("constructs a MessageReference", () => {
    const reference: MessageReference = { conversationId: "conv-1", messageId: "msg-abc" };
    expect(reference.conversationId).toBe("conv-1");
    expect(reference.messageId).toBe("msg-abc");
  });
});

// ──────────────────────────────────────────────
//  Token estimation
// ──────────────────────────────────────────────

describe("estimateConversationTokens", () => {
  it("returns 0 for an empty conversation", () => {
    expect(estimateConversationTokens(makeConversation({ messages: [] }))).toBe(0);
  });

  it("matches the per-message overhead plus content heuristic", () => {
    const conversation = makeConversation({
      messages: [
        makeMessage({ content: "Hello" }),
        makeMessage({ role: "assistant", content: "Hi there!" }),
      ],
    });
    const expected =
      MESSAGE_OVERHEAD_TOKENS +
      estimateTokens("Hello") +
      MESSAGE_OVERHEAD_TOKENS +
      estimateTokens("Hi there!");
    expect(estimateConversationTokens(conversation)).toBe(expected);
  });

  it("is consistent with the shared estimateTokens heuristic", () => {
    const conversation = makeConversation({ messages: [makeMessage({ content: "Hello" })] });
    expect(estimateConversationTokens(conversation)).toBe(EMPTY_MESSAGE_TOKENS);
    expect(EMPTY_MESSAGE_TOKENS).toBe(MESSAGE_OVERHEAD_TOKENS + Math.ceil("Hello".length / 4));
  });

  it("is deterministic across calls", () => {
    const conversation = makeConversation();
    expect(estimateConversationTokens(conversation)).toBe(estimateConversationTokens(conversation));
  });
});

// ──────────────────────────────────────────────
//  Cloning
// ──────────────────────────────────────────────

describe("cloneConversation", () => {
  it("returns a new object, not the same reference", () => {
    const conversation = makeConversation();
    expect(cloneConversation(conversation)).not.toBe(conversation);
  });

  it("deep-equals the source", () => {
    const conversation = makeConversation({ title: "T", tags: ["a"] });
    expect(cloneConversation(conversation)).toEqual(conversation);
  });

  it("detaches every nested object", () => {
    const conversation = makeConversation({ title: "T", tags: ["a"] });
    const clone = cloneConversation(conversation);
    expect(clone.metadata).not.toBe(conversation.metadata);
    expect(clone.metadata.tags).not.toBe(conversation.metadata.tags);
    expect(clone.messages).not.toBe(conversation.messages);
    expect(clone.messages[0]).not.toBe(conversation.messages[0]);
  });

  it("mutating the clone does not affect the source", () => {
    const conversation = makeConversation();
    const clone = cloneConversation(conversation);
    (clone.messages as unknown as ConversationMessage[]).push(
      makeMessage({ role: "system", content: "extra" }),
    );
    (clone.metadata as { title?: string }).title = "Changed";
    expect(conversation.messages).toHaveLength(2);
    expect(conversation.metadata.title).toBeUndefined();
  });

  it("clones a frozen conversation into a fresh unfrozen copy", () => {
    const conversation = freezeConversation(makeConversation({ title: "Frozen" }));
    const clone = cloneConversation(conversation);
    expect(clone).toEqual(conversation);
    expect(Object.isFrozen(clone)).toBe(false);
    expect(Object.isFrozen(clone.messages)).toBe(false);
    expect(Object.isFrozen(clone.messages[0])).toBe(false);
  });
});

// ──────────────────────────────────────────────
//  Freezing
// ──────────────────────────────────────────────

describe("freezeConversation", () => {
  it("returns the same reference (in-place freeze)", () => {
    const conversation = makeConversation();
    expect(freezeConversation(conversation)).toBe(conversation);
  });

  it("freezes metadata, tags, and message metadata", () => {
    const conversation = makeConversation({
      tags: ["a"],
      messages: [makeMessage({ metadata: { toolCallId: "call-1" } })],
    });
    freezeConversation(conversation);
    expect(Object.isFrozen(conversation.metadata)).toBe(true);
    expect(Object.isFrozen(conversation.metadata.tags)).toBe(true);
    expect(Object.isFrozen(conversation.messages[0].metadata)).toBe(true);
  });

  it("blocks assignment to the frozen conversation (throws in strict mode)", () => {
    const conversation = freezeConversation(makeConversation());
    expect(() => {
      (conversation as unknown as { id: string }).id = "changed";
    }).toThrow();
    expect(() => {
      (conversation.metadata as unknown as { state: ConversationState }).state = "deleted";
    }).toThrow();
    expect(() => {
      (conversation.messages as unknown as ConversationMessage[]).push(makeMessage());
    }).toThrow();
    expect(() => {
      (conversation.messages[0] as unknown as { content: string }).content = "changed";
    }).toThrow();
  });

  it("is idempotent", () => {
    const conversation = freezeConversation(makeConversation());
    expect(freezeConversation(conversation)).toBe(conversation);
    expect(Object.isFrozen(conversation)).toBe(true);
  });
});

// ──────────────────────────────────────────────
//  Determinism
// ──────────────────────────────────────────────

describe("determinism", () => {
  it("builds deep-equal conversations from identical inputs", () => {
    const input = {
      id: "c",
      createdAt: "2026-08-01T10:00:00.000Z",
      title: "T",
      tags: ["a"],
      messages: [makeMessage()],
    };
    expect(createConversation(input)).toEqual(createConversation(input));
  });

  it("clones deep-equal conversations from identical sources", () => {
    const source = makeConversation();
    expect(cloneConversation(source)).toEqual(cloneConversation(source));
  });
});

// ──────────────────────────────────────────────
//  Edge cases
// ──────────────────────────────────────────────

describe("edge cases", () => {
  it("handles an empty-string message content", () => {
    const message = makeMessage({ content: "" });
    expect(message.content).toBe("");
    expect(estimateConversationTokens(makeConversation({ messages: [message] }))).toBe(
      MESSAGE_OVERHEAD_TOKENS,
    );
  });

  it("estimates tokens for unicode content by the shared heuristic", () => {
    const content = "héllo wörld 🚀";
    const conversation = makeConversation({ messages: [makeMessage({ content })] });
    expect(estimateConversationTokens(conversation)).toBe(MESSAGE_OVERHEAD_TOKENS + estimateTokens(content));
    expect(estimateTokens(content)).toBe(Math.ceil(content.length / 4));
  });

  it("distinguishes an empty metadata object from no metadata", () => {
    const withEmpty = makeMessage({ metadata: {} });
    const without = makeMessage();
    expect(withEmpty.metadata).toEqual({});
    expect(without.metadata).toBeUndefined();
  });

  it("handles a conversation with no title and no tags", () => {
    const conversation = createConversation({ id: "c", createdAt: "2026-08-01T10:00:00.000Z" });
    expect(conversation.metadata.title).toBeUndefined();
    expect(conversation.metadata.tags).toEqual([]);
  });
});

// ──────────────────────────────────────────────
//  Large conversations
// ──────────────────────────────────────────────

describe("large conversations", () => {
  it("builds, estimates, clones, and freezes a 1000-message conversation", () => {
    const messages = Array.from({ length: 1000 }, (_, index) =>
      makeMessage({ role: index % 2 === 0 ? "user" : "assistant", content: `message ${index}` }),
    );
    const conversation = createConversation({ id: "big", createdAt: "2026-08-01T10:00:00.000Z", messages });

    expect(conversation.messages).toHaveLength(1000);
    expect(conversation.messages[999].content).toBe("message 999");
    expect(conversation.messages[0].content).toBe("message 0");

    const expectedTokens = messages.reduce(
      (sum, message) => sum + MESSAGE_OVERHEAD_TOKENS + estimateTokens(message.content),
      0,
    );
    expect(estimateConversationTokens(conversation)).toBe(expectedTokens);

    const clone = cloneConversation(conversation);
    expect(clone).toEqual(conversation);
    expect(clone.messages[500]).not.toBe(conversation.messages[500]);

    freezeConversation(conversation);
    expect(Object.isFrozen(conversation.messages[999])).toBe(true);
  });
});
