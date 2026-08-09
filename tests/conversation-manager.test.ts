import { describe, it, expect } from "vitest";
import { ConversationManager } from "@/lib/conversation/conversationManager";
import {
  ConversationNotFoundError,
  ConversationDuplicateError,
  ConversationRepository,
} from "@/lib/conversation/repository";
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

/** Build a `CreateConversationInput` (top-level id/createdAt/title/messages). */
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

/** Build a stored `Conversation` (for the repository constructor / updates). */
function makeConversation(
  id: string,
  overrides: Partial<CreateConversationInput> = {},
): Conversation {
  return createConversation(makeConversationInput(id, overrides));
}

// ──────────────────────────────────────────────
//  Construction / reads
// ──────────────────────────────────────────────

describe("construction and reads", () => {
  it("starts empty with an empty repository", () => {
    const manager = new ConversationManager();
    expect(manager.count()).toBe(0);
    expect(manager.listConversations()).toEqual([]);
  });

  it("is seeded by an initial repository", () => {
    const repository = new ConversationRepository([makeConversation("c1")]);
    const manager = new ConversationManager(repository);
    expect(manager.count()).toBe(1);
    expect(manager.getConversation("c1")?.id).toBe("c1");
  });

  it("delegates membership checks to the repository", () => {
    const manager = new ConversationManager(
      new ConversationRepository([makeConversation("c1")]),
    );
    expect(manager.hasConversation("c1")).toBe(true);
    expect(manager.hasConversation("missing")).toBe(false);
  });

  it("returns detached clones on reads", () => {
    const manager = new ConversationManager(
      new ConversationRepository([makeConversation("c1")]),
    );
    const first = manager.getConversation("c1");
    (first?.messages as unknown as ConversationMessage[]).push(makeMessage());
    if (first) first.metadata.title = "Mutated";
    expect(manager.getConversation("c1")?.messages).toHaveLength(1);
    expect(manager.getConversation("c1")?.metadata.title).toBe("Conversation c1");
  });
});

// ──────────────────────────────────────────────
//  startConversation
// ──────────────────────────────────────────────

describe("startConversation", () => {
  it("creates a conversation and returns it plus the successor manager", () => {
    const manager = new ConversationManager();
    const { manager: next, conversation } = manager.startConversation(
      makeConversationInput("c1"),
    );
    expect(conversation.id).toBe("c1");
    expect(next.count()).toBe(1);
    expect(next.getConversation("c1")?.metadata.state).toBe("active");
  });

  it("keeps the receiver unchanged (immutability)", () => {
    const manager = new ConversationManager();
    manager.startConversation(makeConversationInput("c1"));
    expect(manager.count()).toBe(0);
  });

  it("preserves insertion order across starts", () => {
    let manager = new ConversationManager();
    const first = manager.startConversation(makeConversationInput("a"));
    manager = first.manager;
    const second = manager.startConversation(makeConversationInput("b"));
    manager = second.manager;
    const third = manager.startConversation(makeConversationInput("c"));
    expect(third.manager.listConversations().map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("rejects duplicate ids", () => {
    const manager = new ConversationManager(
      new ConversationRepository([makeConversation("c1")]),
    );
    expect(() => manager.startConversation(makeConversationInput("c1"))).toThrow(
      ConversationDuplicateError,
    );
  });
});

// ──────────────────────────────────────────────
//  appendMessage
// ──────────────────────────────────────────────

describe("appendMessage", () => {
  it("appends a message and returns it plus the successor manager", () => {
    const manager = new ConversationManager(
      new ConversationRepository([makeConversation("c1")]),
    );
    const { manager: next, message } = manager.appendMessage("c1", {
      role: "assistant",
      content: "Hi there!",
      createdAt: "2026-08-01T11:00:00.000Z",
    });
    expect(message.role).toBe("assistant");
    expect(message.content).toBe("Hi there!");
    expect(next.getConversation("c1")?.messages).toHaveLength(2);
    expect(next.getConversation("c1")?.messages[1].content).toBe("Hi there!");
  });

  it("keeps the receiver unchanged (immutability)", () => {
    const manager = new ConversationManager(
      new ConversationRepository([makeConversation("c1")]),
    );
    manager.appendMessage("c1", {
      role: "assistant",
      content: "Hi",
      createdAt: "2026-08-01T11:00:00.000Z",
    });
    expect(manager.getConversation("c1")?.messages).toHaveLength(1);
  });

  it("bumps updatedAt when the new message is newer", () => {
    const manager = new ConversationManager(
      new ConversationRepository([makeConversation("c1")]),
    );
    const { manager: next } = manager.appendMessage("c1", {
      role: "assistant",
      content: "Hi",
      createdAt: "2026-08-02T09:00:00.000Z",
    });
    expect(next.getConversation("c1")?.metadata.updatedAt).toBe("2026-08-02T09:00:00.000Z");
  });

  it("keeps updatedAt when the new message is older", () => {
    const manager = new ConversationManager(
      new ConversationRepository([makeConversation("c1")]),
    );
    const { manager: next } = manager.appendMessage("c1", {
      role: "system",
      content: "note",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    expect(next.getConversation("c1")?.metadata.updatedAt).toBe("2026-08-01T10:00:00.000Z");
  });

  it("preserves title, tags, and state while appending", () => {
    const manager = new ConversationManager(
      new ConversationRepository([
        createConversation({
          id: "c1",
          createdAt: "2026-08-01T10:00:00.000Z",
          title: "T",
          tags: ["work"],
          messages: [makeMessage()],
        }),
      ]),
    );
    const { manager: next } = manager.appendMessage("c1", {
      role: "assistant",
      content: "Hi",
      createdAt: "2026-08-02T09:00:00.000Z",
    });
    const conversation = next.getConversation("c1");
    expect(conversation?.metadata.title).toBe("T");
    expect(conversation?.metadata.tags).toEqual(["work"]);
    expect(conversation?.metadata.state).toBe("active");
  });

  it("detaches the appended message from the caller", () => {
    const input = { role: "assistant" as const, content: "Hi", createdAt: "t" };
    const manager = new ConversationManager(
      new ConversationRepository([makeConversation("c1")]),
    );
    const { manager: next, message } = manager.appendMessage("c1", input);
    (input as { content: string }).content = "Changed";
    expect(message.content).toBe("Hi");
    expect(next.getConversation("c1")?.messages[1].content).toBe("Hi");
  });

  it("throws for an unknown conversation", () => {
    const manager = new ConversationManager();
    expect(() =>
      manager.appendMessage("missing", {
        role: "user",
        content: "x",
        createdAt: "t",
      }),
    ).toThrow(ConversationNotFoundError);
  });
});

// ──────────────────────────────────────────────
//  renameConversation
// ──────────────────────────────────────────────

describe("renameConversation", () => {
  it("replaces the title and preserves everything else", () => {
    const manager = new ConversationManager(
      new ConversationRepository([
        createConversation({
          id: "c1",
          createdAt: "2026-08-01T10:00:00.000Z",
          title: "Old",
          tags: ["work"],
          messages: [makeMessage()],
        }),
      ]),
    );
    const next = manager.renameConversation("c1", "New title");
    const conversation = next.getConversation("c1");
    expect(conversation?.metadata.title).toBe("New title");
    expect(conversation?.metadata.tags).toEqual(["work"]);
    expect(conversation?.metadata.updatedAt).toBe("2026-08-01T10:00:00.000Z");
    expect(conversation?.messages).toHaveLength(1);
  });

  it("keeps the receiver unchanged (immutability)", () => {
    const manager = new ConversationManager(
      new ConversationRepository([makeConversation("c1")]),
    );
    manager.renameConversation("c1", "X");
    expect(manager.getConversation("c1")?.metadata.title).toBe("Conversation c1");
  });

  it("throws for an unknown conversation", () => {
    const manager = new ConversationManager();
    expect(() => manager.renameConversation("missing", "X")).toThrow(
      ConversationNotFoundError,
    );
  });
});

// ──────────────────────────────────────────────
//  Lifecycle: archive / restore / close / delete
// ──────────────────────────────────────────────

describe("conversation lifecycle", () => {
  it("archives a conversation", () => {
    const manager = new ConversationManager(
      new ConversationRepository([makeConversation("c1")]),
    );
    const next = manager.archiveConversation("c1");
    expect(next.getConversation("c1")?.metadata.state).toBe("archived");
  });

  it("restores an archived conversation back to active", () => {
    const manager = new ConversationManager(
      new ConversationRepository([makeConversation("c1")]),
    );
    const restored = manager.archiveConversation("c1").restoreConversation("c1");
    expect(restored.getConversation("c1")?.metadata.state).toBe("active");
  });

  it("closeConversation soft-deletes (state 'deleted') while keeping the conversation stored", () => {
    const manager = new ConversationManager(
      new ConversationRepository([makeConversation("c1")]),
    );
    const closed = manager.closeConversation("c1");
    expect(closed.getConversation("c1")?.metadata.state).toBe("deleted");
    expect(closed.getConversation("c1")?.messages).toHaveLength(1);
    expect(closed.count()).toBe(1);
  });

  it("closeConversation is recoverable via restoreConversation", () => {
    const manager = new ConversationManager(
      new ConversationRepository([makeConversation("c1")]),
    );
    const reopened = manager.closeConversation("c1").restoreConversation("c1");
    expect(reopened.getConversation("c1")?.metadata.state).toBe("active");
  });

  it("closeConversation preserves every other field", () => {
    const manager = new ConversationManager(
      new ConversationRepository([makeConversation("c1")]),
    );
    const closed = manager.closeConversation("c1");
    const conversation = closed.getConversation("c1");
    expect(conversation?.metadata.title).toBe("Conversation c1");
    expect(conversation?.metadata.createdAt).toBe("2026-08-01T10:00:00.000Z");
    expect(conversation?.metadata.updatedAt).toBe("2026-08-01T10:00:00.000Z");
  });

  it("deleteConversation removes the conversation entirely (hard delete)", () => {
    const manager = new ConversationManager(
      new ConversationRepository([makeConversation("c1")]),
    );
    const deleted = manager.deleteConversation("c1");
    expect(deleted.count()).toBe(0);
    expect(deleted.hasConversation("c1")).toBe(false);
    expect(deleted.getConversation("c1")).toBeUndefined();
  });

  it("close and delete are distinct operations", () => {
    const manager = new ConversationManager(
      new ConversationRepository([makeConversation("c1")]),
    );
    const closed = manager.closeConversation("c1");
    expect(closed.hasConversation("c1")).toBe(true);
    const deleted = manager.deleteConversation("c1");
    expect(deleted.hasConversation("c1")).toBe(false);
  });

  it("all lifecycle operations leave the receiver unchanged", () => {
    const manager = new ConversationManager(
      new ConversationRepository([makeConversation("c1")]),
    );
    manager.archiveConversation("c1");
    manager.closeConversation("c1");
    manager.deleteConversation("c1");
    expect(manager.getConversation("c1")?.metadata.state).toBe("active");
    expect(manager.count()).toBe(1);
  });

  it("throws for unknown ids on every lifecycle operation", () => {
    const manager = new ConversationManager();
    expect(() => manager.archiveConversation("missing")).toThrow(ConversationNotFoundError);
    expect(() => manager.restoreConversation("missing")).toThrow(ConversationNotFoundError);
    expect(() => manager.closeConversation("missing")).toThrow(ConversationNotFoundError);
    expect(() => manager.deleteConversation("missing")).toThrow(ConversationNotFoundError);
  });

  it("keeps insertion order across lifecycle transitions", () => {
    const manager = new ConversationManager(
      new ConversationRepository([makeConversation("a"), makeConversation("b"), makeConversation("c")]),
    );
    const next = manager.closeConversation("b");
    expect(next.listConversations().map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(next.listConversations()[1].metadata.state).toBe("deleted");
  });
});

// ──────────────────────────────────────────────
//  Chained flows
// ──────────────────────────────────────────────

describe("chained flows", () => {
  it("start → append → rename → archive in one immutable chain", () => {
    let manager = new ConversationManager();
    const started = manager.startConversation(
      makeConversationInput("c1", { messages: [] }),
    );
    manager = started.manager;
    const appended = manager.appendMessage("c1", {
      role: "user",
      content: "Summarize my week",
      createdAt: "2026-08-03T09:00:00.000Z",
    });
    manager = appended.manager;
    manager = manager.renameConversation("c1", "Weekly recap");
    manager = manager.archiveConversation("c1");
    const conversation = manager.getConversation("c1");
    expect(conversation?.metadata.title).toBe("Weekly recap");
    expect(conversation?.metadata.state).toBe("archived");
    expect(conversation?.metadata.updatedAt).toBe("2026-08-03T09:00:00.000Z");
    expect(conversation?.messages).toHaveLength(1);
  });

  it("repeated appendMessage preserves message order", () => {
    let manager = new ConversationManager();
    const started = manager.startConversation(makeConversationInput("c1", { messages: [] }));
    manager = started.manager;
    for (let index = 0; index < 5; index += 1) {
      const appended = manager.appendMessage("c1", {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index}`,
        createdAt: `2026-08-01T10:0${index}:00.000Z`,
      });
      manager = appended.manager;
    }
    expect(manager.getConversation("c1")?.messages.map((m) => m.content)).toEqual([
      "message 0",
      "message 1",
      "message 2",
      "message 3",
      "message 4",
    ]);
  });
});

// ──────────────────────────────────────────────
//  Determinism
// ──────────────────────────────────────────────

describe("determinism", () => {
  it("produces deep-equal manager states from identical operation sequences", () => {
    const run = (): ConversationManager => {
      let manager = new ConversationManager();
      const started = manager.startConversation(makeConversationInput("a"));
      manager = started.manager;
      const appended = manager.appendMessage("a", {
        role: "assistant",
        content: "Hi",
        createdAt: "2026-08-02T09:00:00.000Z",
      });
      manager = appended.manager.renameConversation("a", "Renamed");
      manager = manager.closeConversation("a");
      return manager;
    };
    expect(run().listConversations()).toEqual(run().listConversations());
    expect(run().getConversation("a")).toEqual(run().getConversation("a"));
  });
});

// ──────────────────────────────────────────────
//  Large manager state
// ──────────────────────────────────────────────

describe("large manager state", () => {
  it("handles 1000 conversations with correct ordering and counts", () => {
    let manager = new ConversationManager();
    for (let index = 0; index < 1000; index += 1) {
      const started = manager.startConversation(makeConversationInput(`c${index}`));
      manager = started.manager;
    }
    expect(manager.count()).toBe(1000);
    expect(manager.listConversations()[0].id).toBe("c0");
    expect(manager.listConversations()[999].id).toBe("c999");
    expect(manager.closeConversation("c500").getConversation("c500")?.metadata.state).toBe(
      "deleted",
    );
  });

  it("appends 1000 messages to a single conversation in order", () => {
    let manager = new ConversationManager();
    const started = manager.startConversation(makeConversationInput("big", { messages: [] }));
    manager = started.manager;
    for (let index = 0; index < 1000; index += 1) {
      const appended = manager.appendMessage("big", {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index}`,
        createdAt: `2026-08-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
      });
      manager = appended.manager;
    }
    expect(manager.getConversation("big")?.messages).toHaveLength(1000);
    expect(manager.getConversation("big")?.messages[999].content).toBe("message 999");
  });
});
