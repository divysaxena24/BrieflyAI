import { describe, it, expect } from "vitest";
import {
  summarizeWindow,
  summarizeConversation,
  truncateIfNeeded,
  estimateConversationTokens,
} from "@/lib/conversation/summarizer";
import {
  createConversation,
  createMessage,
  estimateConversationTokens as estimateConversationTokensFromTypes,
  MESSAGE_OVERHEAD_TOKENS,
  type Conversation,
  type ConversationMessage,
} from "@/lib/conversation/types";
import { estimateTokens } from "@/lib/context/tokenBudget";

// ──────────────────────────────────────────────
//  Fixtures
// ──────────────────────────────────────────────

/** Message with content of exactly `characters` "a"s (cost overhead + ceil(len/4)). */
function makeMessage(index: number, content = "a".repeat(4)): ConversationMessage {
  return createMessage({
    role: index % 2 === 0 ? "user" : "assistant",
    content,
    createdAt: `2026-08-01T10:00:${String(index).padStart(2, "0")}.000Z`,
  });
}

const MESSAGE_COST = MESSAGE_OVERHEAD_TOKENS + estimateTokens("a".repeat(4)); // 3 + 1

function makeConversation(
  id: string,
  messages: readonly ConversationMessage[] = [makeMessage(0)],
): Conversation {
  return createConversation({
    id,
    createdAt: "2026-08-01T10:00:00.000Z",
    title: `Conversation ${id}`,
    tags: ["work"],
    messages,
  });
}

/** A transcript starting with a system message. */
function makeSystemConversation(id: string, tailCount: number): Conversation {
  const messages: ConversationMessage[] = [
    createMessage({
      role: "system",
      content: "sys",
      createdAt: "2026-08-01T09:00:00.000Z",
    }),
  ];
  for (let index = 0; index < tailCount; index += 1) {
    messages.push(makeMessage(index));
  }
  return makeConversation(id, messages);
}

// ──────────────────────────────────────────────
//  estimateConversationTokens (re-export)
// ──────────────────────────────────────────────

describe("estimateConversationTokens", () => {
  it("re-exports the shared estimator from ./types", () => {
    const conversation = makeConversation("c1", [makeMessage(0), makeMessage(1)]);
    expect(estimateConversationTokens).toBe(estimateConversationTokensFromTypes);
    expect(estimateConversationTokens(conversation)).toBe(
      estimateConversationTokensFromTypes(conversation),
    );
  });
});

// ──────────────────────────────────────────────
//  summarizeWindow
// ──────────────────────────────────────────────

describe("summarizeWindow", () => {
  it("returns every message when the budget covers the transcript", () => {
    const messages = [makeMessage(0), makeMessage(1), makeMessage(2)];
    const window = summarizeWindow(messages, MESSAGE_COST * 3);
    expect(window).toEqual(messages);
  });

  it("returns the longest suffix fitting the budget, oldest first", () => {
    const messages = [makeMessage(0), makeMessage(1), makeMessage(2), makeMessage(3)];
    // Budget holds 2 messages (2 × MESSAGE_COST).
    const window = summarizeWindow(messages, MESSAGE_COST * 2);
    expect(window.map((m) => m.content)).toEqual(["a".repeat(4), "a".repeat(4)]);
    expect(window[0]).toBe(messages[2]);
    expect(window[1]).toBe(messages[3]);
  });

  it("returns an empty array for a non-positive budget", () => {
    const messages = [makeMessage(0)];
    expect(summarizeWindow(messages, 0)).toEqual([]);
    expect(summarizeWindow(messages, -5)).toEqual([]);
  });

  it("returns an empty array for an empty transcript", () => {
    expect(summarizeWindow([], 100)).toEqual([]);
  });

  it("never includes a message that would exceed the budget", () => {
    const messages = [makeMessage(0, "a".repeat(4)), makeMessage(1, "a".repeat(100))];
    // First (newest) message alone costs 3 + 25 = 28; a budget of 20 fits nothing.
    const window = summarizeWindow(messages, 20);
    expect(window).toEqual([]);
  });

  it("is deterministic and never mutates the input", () => {
    const messages = [makeMessage(0), makeMessage(1), makeMessage(2), makeMessage(3)];
    const snapshot = JSON.stringify(messages);
    expect(summarizeWindow(messages, MESSAGE_COST * 2)).toEqual(
      summarizeWindow(messages, MESSAGE_COST * 2),
    );
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});

// ──────────────────────────────────────────────
//  summarizeConversation — token cap
// ──────────────────────────────────────────────

describe("summarizeConversation (token cap)", () => {
  it("returns the same conversation when it already fits the caps", () => {
    const conversation = makeConversation("c1", [makeMessage(0), makeMessage(1)]);
    expect(summarizeConversation(conversation, { maxTokens: MESSAGE_COST * 2 })).toBe(
      conversation,
    );
  });

  it("keeps the system head plus the recent tail when over budget", () => {
    // system (4 tokens incl. overhead) + 4 tail messages (4 tokens each) = 20.
    const conversation = makeSystemConversation("c1", 4);
    expect(estimateConversationTokens(conversation)).toBe(4 + MESSAGE_COST * 4);

    // Budget 12 → head (4) + 2 most recent tail messages (8). The tail is
    // makeMessage(0..3) = user, assistant, user, assistant, so the 2 most
    // recent are user (2) and assistant (3).
    const summarized = summarizeConversation(conversation, { maxTokens: 12 });
    expect(summarized.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
    expect(summarized.messages[0].content).toBe("sys");
    expect(estimateConversationTokens(summarized)).toBeLessThanOrEqual(12);
  });

  it("drops the oldest non-system messages first", () => {
    const conversation = makeSystemConversation("c1", 6);
    const summarized = summarizeConversation(conversation, { maxTokens: 12 });
    const contents = summarized.messages.map((m) => m.content);
    expect(contents[0]).toBe("sys");
    // The tail holds messages 4 and 5 (the most recent two).
    expect(contents).toContain("a".repeat(4));
    expect(summarized.messages).toHaveLength(3);
  });

  it("keeps only the system head when the budget cannot hold any tail", () => {
    const conversation = makeSystemConversation("c1", 4);
    const summarized = summarizeConversation(conversation, { maxTokens: 4 });
    expect(summarized.messages).toHaveLength(1);
    expect(summarized.messages[0].role).toBe("system");
  });

  it("preserves every metadata field when truncating", () => {
    const conversation = makeSystemConversation("c1", 6);
    const summarized = summarizeConversation(conversation, { maxTokens: 12 });
    expect(summarized.id).toBe("c1");
    expect(summarized.metadata.title).toBe("Conversation c1");
    expect(summarized.metadata.tags).toEqual(["work"]);
    expect(summarized.metadata.state).toBe("active");
    expect(summarized.metadata.createdAt).toBe("2026-08-01T10:00:00.000Z");
    expect(summarized.metadata.updatedAt).toBe(conversation.metadata.updatedAt);
  });

  it("returns a new conversation (never mutates the input)", () => {
    const conversation = makeSystemConversation("c1", 6);
    const snapshot = JSON.stringify(conversation);
    const summarized = summarizeConversation(conversation, { maxTokens: 12 });
    expect(summarized).not.toBe(conversation);
    expect(JSON.stringify(conversation)).toBe(snapshot);
    expect(conversation.messages).toHaveLength(7);
  });
});

// ──────────────────────────────────────────────
//  summarizeConversation — message cap
// ──────────────────────────────────────────────

describe("summarizeConversation (message cap)", () => {
  it("keeps the most recent maxMessages when no token cap is given", () => {
    const conversation = makeConversation("c1", [
      makeMessage(0),
      makeMessage(1),
      makeMessage(2),
      makeMessage(3),
      makeMessage(4),
    ]);
    const summarized = summarizeConversation(conversation, { maxMessages: 3 });
    expect(summarized.messages.map((m) => m.content)).toEqual([
      "a".repeat(4),
      "a".repeat(4),
      "a".repeat(4),
    ]);
    // The summary is a detached clone — the newest message content is kept.
    expect(summarized.messages[summarized.messages.length - 1].content).toBe(
      conversation.messages[4].content,
    );
    expect(summarized.messages[0].content).toBe(conversation.messages[2].content);
  });

  it("reserves a leading system message against the cap", () => {
    const conversation = makeSystemConversation("c1", 5);
    const summarized = summarizeConversation(conversation, { maxMessages: 3 });
    expect(summarized.messages.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "user",
    ]);
  });

  it("keeps only the system head when the cap equals the head", () => {
    const conversation = makeSystemConversation("c1", 5);
    const summarized = summarizeConversation(conversation, { maxMessages: 1 });
    expect(summarized.messages.map((m) => m.role)).toEqual(["system"]);
  });

  it("returns no messages for a zero message cap, even with a system head", () => {
    const conversation = makeSystemConversation("c1", 3);
    const summarized = summarizeConversation(conversation, { maxMessages: 0 });
    expect(summarized.messages).toEqual([]);
  });

  it("enforces both caps together", () => {
    const conversation = makeSystemConversation("c1", 10);
    // Budget 8 holds head (4) + 1 tail (4); maxMessages 2 allows head + 1 tail.
    const summarized = summarizeConversation(conversation, {
      maxTokens: 8,
      maxMessages: 2,
    });
    expect(summarized.messages).toHaveLength(2);
    expect(summarized.messages.map((m) => m.role)).toEqual(["system", "assistant"]);
    expect(estimateConversationTokens(summarized)).toBeLessThanOrEqual(8);
  });

  it("returns the same conversation when the cap is not exceeded", () => {
    const conversation = makeConversation("c1", [makeMessage(0), makeMessage(1)]);
    expect(summarizeConversation(conversation, { maxMessages: 5 })).toBe(conversation);
  });
});

// ──────────────────────────────────────────────
//  truncateIfNeeded
// ──────────────────────────────────────────────

describe("truncateIfNeeded", () => {
  it("returns the conversation unchanged when within budget", () => {
    const conversation = makeConversation("c1", [makeMessage(0)]);
    expect(truncateIfNeeded(conversation, MESSAGE_COST)).toBe(conversation);
  });

  it("truncates to the budget when over", () => {
    const conversation = makeConversation("c1", [makeMessage(0), makeMessage(1)]);
    const truncated = truncateIfNeeded(conversation, MESSAGE_COST);
    expect(truncated).not.toBe(conversation);
    expect(truncated.messages).toHaveLength(1);
    expect(estimateConversationTokens(truncated)).toBeLessThanOrEqual(MESSAGE_COST);
  });

  it("returns an empty conversation unchanged", () => {
    const conversation = makeConversation("c1", []);
    expect(truncateIfNeeded(conversation, 0)).toBe(conversation);
    expect(truncateIfNeeded(conversation, 100)).toBe(conversation);
  });

  it("is consistent with summarizeConversation for the token cap", () => {
    const conversation = makeConversation("c1", [
      makeMessage(0),
      makeMessage(1),
      makeMessage(2),
      makeMessage(3),
    ]);
    expect(truncateIfNeeded(conversation, MESSAGE_COST * 10)).toBe(conversation);
    expect(truncateIfNeeded(conversation, MESSAGE_COST * 2)).toEqual(
      summarizeConversation(conversation, { maxTokens: MESSAGE_COST * 2 }),
    );
  });
});

// ──────────────────────────────────────────────
//  Determinism and scale
// ──────────────────────────────────────────────

describe("determinism and scale", () => {
  it("produces deep-equal results from identical inputs", () => {
    const conversation = makeSystemConversation("c1", 8);
    expect(summarizeConversation(conversation, { maxTokens: 20 })).toEqual(
      summarizeConversation(conversation, { maxTokens: 20 }),
    );
    expect(truncateIfNeeded(conversation, 20)).toEqual(truncateIfNeeded(conversation, 20));
  });

  it("summarizes a 1000-message conversation correctly and quickly", () => {
    const messages = Array.from({ length: 1000 }, (_, index) => makeMessage(index));
    const conversation = makeConversation("big", messages);
    const summarized = summarizeConversation(conversation, { maxTokens: 50, maxMessages: 100 });
    expect(summarized.messages.length).toBeGreaterThan(0);
    expect(summarized.messages.length).toBeLessThanOrEqual(100);
    expect(estimateConversationTokens(summarized)).toBeLessThanOrEqual(50);
    // The most recent message is always kept (content-wise; the summary is a
    // detached clone, so references differ).
    expect(summarized.messages[summarized.messages.length - 1].content).toBe(
      messages[999].content,
    );
  });

  it("window returns the exact most recent message for a tiny budget", () => {
    const messages = Array.from({ length: 100 }, (_, index) => makeMessage(index));
    const window = summarizeWindow(messages, MESSAGE_COST);
    expect(window).toHaveLength(1);
    expect(window[0]).toBe(messages[99]);
  });
});
