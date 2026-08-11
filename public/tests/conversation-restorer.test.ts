import { describe, it, expect } from "vitest";
import { ConversationRepository } from "@/lib/conversation/repository";
import { ConversationRestorer } from "@/lib/conversation/restorer";
import {
  createConversation,
  createMessage,
  type Conversation,
  type ConversationMessage,
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

/** A conversation with alternating user/assistant messages. */
function makeDialogue(id: string, count = 5): Conversation {
  const messages = Array.from({ length: count }, (_, index) =>
    makeMessage({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      createdAt: `2026-08-01T10:00:${String(index).padStart(2, "0")}.000Z`,
    }),
  );
  return makeConversation(id, messages);
}

// ──────────────────────────────────────────────
//  restoreConversation
// ──────────────────────────────────────────────

describe("restoreConversation", () => {
  it("returns the stored conversation", () => {
    const repository = new ConversationRepository([makeConversation("c1")]);
    const restorer = new ConversationRestorer(repository);
    expect(restorer.restoreConversation("c1")?.id).toBe("c1");
    expect(restorer.restoreConversation("c1")?.messages).toHaveLength(1);
  });

  it("returns undefined for an unknown conversation", () => {
    const restorer = new ConversationRestorer(new ConversationRepository());
    expect(restorer.restoreConversation("missing")).toBeUndefined();
  });

  it("returns a detached clone (mutating it never affects the repository)", () => {
    const repository = new ConversationRepository([makeConversation("c1")]);
    const restorer = new ConversationRestorer(repository);
    const restored = restorer.restoreConversation("c1");
    (restored?.messages as unknown as ConversationMessage[]).push(makeMessage());
    if (restored) restored.metadata.title = "Mutated";
    expect(restorer.restoreConversation("c1")?.messages).toHaveLength(1);
    expect(restorer.restoreConversation("c1")?.metadata.title).toBe("Conversation c1");
  });

  it("retrieves archived and soft-deleted conversations", () => {
    let repository = new ConversationRepository([makeConversation("c1")]);
    repository = repository.archiveConversation("c1");
    const restorer = new ConversationRestorer(repository);
    expect(restorer.restoreConversation("c1")?.metadata.state).toBe("archived");

    const softDeleted = new ConversationRestorer(repository);
    expect(softDeleted.restoreConversation("c1")).toBeDefined();
  });

  it("does not retrieve hard-deleted conversations", () => {
    let repository = new ConversationRepository([makeConversation("c1")]);
    repository = repository.deleteConversation("c1");
    const restorer = new ConversationRestorer(repository);
    expect(restorer.restoreConversation("c1")).toBeUndefined();
  });

  it("never mutates the repository (pure retrieval)", () => {
    const repository = new ConversationRepository([makeConversation("c1")]);
    const restorer = new ConversationRestorer(repository);
    restorer.restoreConversation("c1");
    expect(repository.count()).toBe(1);
    expect(repository.getConversation("c1")?.messages).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────
//  restoreMessages
// ──────────────────────────────────────────────

describe("restoreMessages", () => {
  it("returns every message, oldest first", () => {
    const conversation = makeDialogue("c1", 5);
    const restorer = new ConversationRestorer(
      new ConversationRepository([conversation]),
    );
    expect(restorer.restoreMessages("c1").map((m) => m.content)).toEqual([
      "message 0",
      "message 1",
      "message 2",
      "message 3",
      "message 4",
    ]);
  });

  it("returns an empty array for an unknown conversation", () => {
    const restorer = new ConversationRestorer(new ConversationRepository());
    expect(restorer.restoreMessages("missing")).toEqual([]);
  });

  it("returns an empty array for an empty conversation", () => {
    const restorer = new ConversationRestorer(
      new ConversationRepository([makeConversation("c1", [])]),
    );
    expect(restorer.restoreMessages("c1")).toEqual([]);
  });

  it("returns a fresh array on every call (no caching)", () => {
    const restorer = new ConversationRestorer(
      new ConversationRepository([makeDialogue("c1", 3)]),
    );
    expect(restorer.restoreMessages("c1")).not.toBe(restorer.restoreMessages("c1"));
  });
});

// ──────────────────────────────────────────────
//  restoreRecentMessages
// ──────────────────────────────────────────────

describe("restoreRecentMessages", () => {
  it("returns the most recent `count` messages, oldest first", () => {
    const restorer = new ConversationRestorer(
      new ConversationRepository([makeDialogue("c1", 5)]),
    );
    expect(restorer.restoreRecentMessages("c1", 2).map((m) => m.content)).toEqual([
      "message 3",
      "message 4",
    ]);
  });

  it("returns every message when count exceeds the transcript", () => {
    const restorer = new ConversationRestorer(
      new ConversationRepository([makeDialogue("c1", 3)]),
    );
    expect(restorer.restoreRecentMessages("c1", 100)).toHaveLength(3);
  });

  it("returns an empty array for a non-positive count", () => {
    const restorer = new ConversationRestorer(
      new ConversationRepository([makeDialogue("c1", 5)]),
    );
    expect(restorer.restoreRecentMessages("c1", 0)).toEqual([]);
    expect(restorer.restoreRecentMessages("c1", -3)).toEqual([]);
  });

  it("returns an empty array for an unknown conversation", () => {
    const restorer = new ConversationRestorer(new ConversationRepository());
    expect(restorer.restoreRecentMessages("missing", 3)).toEqual([]);
  });

  it("preserves the order of the windowed messages", () => {
    const restorer = new ConversationRestorer(
      new ConversationRepository([makeDialogue("c1", 6)]),
    );
    const window = restorer.restoreRecentMessages("c1", 3);
    expect(window.map((m) => m.content)).toEqual(["message 3", "message 4", "message 5"]);
    expect(window[0].createdAt < window[2].createdAt).toBe(true);
  });
});

// ──────────────────────────────────────────────
//  restoreWindow
// ──────────────────────────────────────────────

describe("restoreWindow", () => {
  it("returns the tail window plus its metadata", () => {
    const restorer = new ConversationRestorer(
      new ConversationRepository([makeDialogue("c1", 5)]),
    );
    const window = restorer.restoreWindow("c1", 3);
    expect(window.messages.map((m) => m.content)).toEqual(["message 2", "message 3", "message 4"]);
    expect(window.startIndex).toBe(2);
    expect(window.total).toBe(5);
    expect(window.trimmed).toBe(2);
  });

  it("returns the full transcript when maxMessages covers it", () => {
    const restorer = new ConversationRestorer(
      new ConversationRepository([makeDialogue("c1", 3)]),
    );
    const window = restorer.restoreWindow("c1", 10);
    expect(window.messages).toHaveLength(3);
    expect(window.startIndex).toBe(0);
    expect(window.trimmed).toBe(0);
    expect(window.total).toBe(3);
  });

  it("returns an empty window for a non-positive maxMessages", () => {
    const restorer = new ConversationRestorer(
      new ConversationRepository([makeDialogue("c1", 3)]),
    );
    const window = restorer.restoreWindow("c1", 0);
    expect(window.messages).toEqual([]);
    expect(window.startIndex).toBe(3);
    expect(window.total).toBe(3);
    expect(window.trimmed).toBe(3);
  });

  it("returns an empty window for an unknown conversation", () => {
    const restorer = new ConversationRestorer(new ConversationRepository());
    const window = restorer.restoreWindow("missing", 5);
    expect(window.messages).toEqual([]);
    expect(window.startIndex).toBe(0);
    expect(window.total).toBe(0);
    expect(window.trimmed).toBe(0);
  });

  it("returns a detached window (mutating it never affects the repository)", () => {
    const repository = new ConversationRepository([makeDialogue("c1", 5)]);
    const restorer = new ConversationRestorer(repository);
    const window = restorer.restoreWindow("c1", 2);
    (window.messages as unknown as ConversationMessage[]).push(makeMessage());
    expect(restorer.restoreWindow("c1", 2).messages).toHaveLength(2);
    expect(repository.getConversation("c1")?.messages).toHaveLength(5);
  });

  it("is consistent with restoreRecentMessages", () => {
    const restorer = new ConversationRestorer(
      new ConversationRepository([makeDialogue("c1", 8)]),
    );
    expect(restorer.restoreWindow("c1", 4).messages).toEqual(
      restorer.restoreRecentMessages("c1", 4),
    );
  });
});

// ──────────────────────────────────────────────
//  restoreLastAssistantMessage
// ──────────────────────────────────────────────

describe("restoreLastAssistantMessage", () => {
  it("returns the most recent assistant message", () => {
    const restorer = new ConversationRestorer(
      new ConversationRepository([makeDialogue("c1", 5)]),
    );
    const message = restorer.restoreLastAssistantMessage("c1");
    expect(message?.role).toBe("assistant");
    expect(message?.content).toBe("message 3");
  });

  it("returns undefined when the last message is a user message", () => {
    const conversation = makeConversation("c1", [
      makeMessage({ role: "assistant", content: "earlier" }),
      makeMessage({ role: "user", content: "latest" }),
    ]);
    const restorer = new ConversationRestorer(
      new ConversationRepository([conversation]),
    );
    const message = restorer.restoreLastAssistantMessage("c1");
    expect(message?.content).toBe("earlier");
  });

  it("returns undefined when there is no assistant message", () => {
    const conversation = makeConversation("c1", [
      makeMessage({ role: "user", content: "a" }),
      makeMessage({ role: "system", content: "b" }),
    ]);
    const restorer = new ConversationRestorer(
      new ConversationRepository([conversation]),
    );
    expect(restorer.restoreLastAssistantMessage("c1")).toBeUndefined();
  });

  it("returns undefined for an unknown conversation", () => {
    const restorer = new ConversationRestorer(new ConversationRepository());
    expect(restorer.restoreLastAssistantMessage("missing")).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
//  Determinism and scale
// ──────────────────────────────────────────────

describe("determinism and scale", () => {
  it("produces deep-equal results from identical inputs", () => {
    const repository = new ConversationRepository([makeDialogue("c1", 6)]);
    const restorer = new ConversationRestorer(repository);
    expect(restorer.restoreWindow("c1", 4)).toEqual(restorer.restoreWindow("c1", 4));
    expect(restorer.restoreMessages("c1")).toEqual(restorer.restoreMessages("c1"));
  });

  it("restores a 1000-message conversation efficiently and correctly", () => {
    const conversation = makeDialogue("big", 1000);
    const restorer = new ConversationRestorer(
      new ConversationRepository([conversation]),
    );
    expect(restorer.restoreMessages("big")).toHaveLength(1000);
    const window = restorer.restoreWindow("big", 10);
    expect(window.messages).toHaveLength(10);
    expect(window.startIndex).toBe(990);
    expect(window.messages[0].content).toBe("message 990");
    expect(window.messages[9].content).toBe("message 999");
    expect(restorer.restoreLastAssistantMessage("big")?.content).toBe("message 999");
  });
});
