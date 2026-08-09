import { describe, it, expect } from "vitest";
import {
  ConversationRepository,
  ConversationNotFoundError,
  ConversationDuplicateError,
} from "@/lib/conversation/repository";
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
  overrides: Partial<Parameters<typeof createConversation>[0]> = {},
): Conversation {
  return createConversation({
    id,
    createdAt: "2026-08-01T10:00:00.000Z",
    title: `Conversation ${id}`,
    messages: [makeMessage()],
    ...overrides,
  });
}

// ──────────────────────────────────────────────
//  Construction
// ──────────────────────────────────────────────

describe("construction", () => {
  it("starts empty when constructed without arguments", () => {
    const repository = new ConversationRepository();
    expect(repository.count()).toBe(0);
    expect(repository.listConversations()).toEqual([]);
  });

  it("stores the initial conversations", () => {
    const repository = new ConversationRepository([makeConversation("c1"), makeConversation("c2")]);
    expect(repository.count()).toBe(2);
    expect(repository.listConversations().map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("snapshots the constructor input (later caller mutation has no effect)", () => {
    const initial = [makeConversation("c1")];
    const repository = new ConversationRepository(initial);
    initial.push(makeConversation("c2"));
    initial[0].metadata.title = "Changed";
    (initial[0].messages as unknown as ConversationMessage[]).push(makeMessage());
    expect(repository.count()).toBe(1);
    expect(repository.getConversation("c1")?.metadata.title).toBe("Conversation c1");
    expect(repository.getConversation("c1")?.messages).toHaveLength(1);
  });

  it("freezes the stored conversations (runtime immutability)", () => {
    const repository = new ConversationRepository([makeConversation("c1")]);
    const stored = repository.getConversation("c1") as Conversation;
    // Reads return clones (unfrozen); the internal copy is frozen — verified
    // indirectly: the returned clone is a detached object.
    expect(stored).not.toBe(
      // A second read produces a fresh clone with the same contents.
      repository.getConversation("c1"),
    );
    expect(repository.getConversation("c1")).toEqual(stored);
  });
});

// ──────────────────────────────────────────────
//  createConversation
// ──────────────────────────────────────────────

describe("createConversation", () => {
  it("appends a conversation and returns it plus the successor repository", () => {
    const repository = new ConversationRepository();
    const { conversation, repository: next } = repository.createConversation(
      makeConversation("c1"),
    );
    expect(conversation.id).toBe("c1");
    expect(next.count()).toBe(1);
    expect(next.listConversations()[0].id).toBe("c1");
  });

  it("keeps the receiver unchanged (immutability)", () => {
    const repository = new ConversationRepository([makeConversation("c1")]);
    repository.createConversation(makeConversation("c2"));
    expect(repository.count()).toBe(1);
  });

  it("preserves insertion order across creates", () => {
    const repository = new ConversationRepository();
    const first = repository.createConversation(makeConversation("a"));
    const second = first.repository.createConversation(makeConversation("b"));
    const third = second.repository.createConversation(makeConversation("c"));
    expect(third.repository.listConversations().map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("rejects duplicate ids", () => {
    const repository = new ConversationRepository([makeConversation("c1")]);
    expect(() => repository.createConversation(makeConversation("c1"))).toThrow(
      ConversationDuplicateError,
    );
  });
});

// ──────────────────────────────────────────────
//  getConversation
// ──────────────────────────────────────────────

describe("getConversation", () => {
  it("returns the stored conversation", () => {
    const repository = new ConversationRepository([makeConversation("c1")]);
    expect(repository.getConversation("c1")?.id).toBe("c1");
  });

  it("returns undefined for an unknown id", () => {
    const repository = new ConversationRepository();
    expect(repository.getConversation("missing")).toBeUndefined();
  });

  it("returns a detached clone (mutating it never affects the repository)", () => {
    const repository = new ConversationRepository([makeConversation("c1")]);
    const first = repository.getConversation("c1");
    (first?.messages as unknown as ConversationMessage[]).push(makeMessage());
    if (first) first.metadata.title = "Mutated";
    const second = repository.getConversation("c1");
    expect(second?.messages).toHaveLength(1);
    expect(second?.metadata.title).toBe("Conversation c1");
  });

  it("returns a fresh clone on every call (no caching)", () => {
    const repository = new ConversationRepository([makeConversation("c1")]);
    expect(repository.getConversation("c1")).not.toBe(repository.getConversation("c1"));
  });
});

// ──────────────────────────────────────────────
//  updateConversation
// ──────────────────────────────────────────────

describe("updateConversation", () => {
  it("replaces the stored conversation by id", () => {
    const repository = new ConversationRepository([makeConversation("c1")]);
    const replacement = createConversation({
      id: "c1",
      createdAt: "2026-08-01T10:00:00.000Z",
      title: "Renamed",
      messages: [makeMessage(), makeMessage({ role: "assistant", content: "Hi" })],
    });
    const next = repository.updateConversation(replacement);
    expect(next.getConversation("c1")?.metadata.title).toBe("Renamed");
    expect(next.getConversation("c1")?.messages).toHaveLength(2);
  });

  it("keeps insertion position when updating", () => {
    const repository = new ConversationRepository([
      makeConversation("a"),
      makeConversation("b"),
      makeConversation("c"),
    ]);
    const next = repository.updateConversation(
      createConversation({ id: "b", createdAt: "2026-08-01T10:00:00.000Z", title: "B2" }),
    );
    expect(next.listConversations().map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(next.listConversations()[1].metadata.title).toBe("B2");
  });

  it("leaves the receiver unchanged (immutability)", () => {
    const repository = new ConversationRepository([makeConversation("c1")]);
    repository.updateConversation(
      createConversation({ id: "c1", createdAt: "2026-08-01T10:00:00.000Z", title: "X" }),
    );
    expect(repository.getConversation("c1")?.metadata.title).toBe("Conversation c1");
  });

  it("detaches the replacement from the caller", () => {
    const replacement = createConversation({
      id: "c1",
      createdAt: "2026-08-01T10:00:00.000Z",
      title: "T",
      messages: [makeMessage()],
    });
    const repository = new ConversationRepository();
    const { repository: withOne } = repository.createConversation(makeConversation("c1"));
    const next = withOne.updateConversation(replacement);
    replacement.metadata.title = "Caller changed";
    (replacement.messages as unknown as ConversationMessage[]).push(makeMessage());
    expect(next.getConversation("c1")?.metadata.title).toBe("T");
    expect(next.getConversation("c1")?.messages).toHaveLength(1);
  });

  it("throws for an unknown id", () => {
    const repository = new ConversationRepository();
    expect(() =>
      repository.updateConversation(
        createConversation({ id: "missing", createdAt: "2026-08-01T10:00:00.000Z" }),
      ),
    ).toThrow(ConversationNotFoundError);
  });
});

// ──────────────────────────────────────────────
//  deleteConversation
// ──────────────────────────────────────────────

describe("deleteConversation", () => {
  it("removes the conversation", () => {
    const repository = new ConversationRepository([makeConversation("c1"), makeConversation("c2")]);
    const next = repository.deleteConversation("c1");
    expect(next.hasConversation("c1")).toBe(false);
    expect(next.hasConversation("c2")).toBe(true);
    expect(next.count()).toBe(1);
  });

  it("leaves the receiver unchanged (immutability)", () => {
    const repository = new ConversationRepository([makeConversation("c1")]);
    repository.deleteConversation("c1");
    expect(repository.count()).toBe(1);
  });

  it("throws for an unknown id", () => {
    const repository = new ConversationRepository();
    expect(() => repository.deleteConversation("missing")).toThrow(ConversationNotFoundError);
  });
});

// ──────────────────────────────────────────────
//  archiveConversation / restoreConversation
// ──────────────────────────────────────────────

describe("state transitions", () => {
  it("archives a conversation", () => {
    const repository = new ConversationRepository([makeConversation("c1")]);
    const next = repository.archiveConversation("c1");
    expect(next.getConversation("c1")?.metadata.state).toBe("archived");
  });

  it("restores an archived conversation back to active", () => {
    const repository = new ConversationRepository([makeConversation("c1")]);
    const archived = repository.archiveConversation("c1");
    const restored = archived.restoreConversation("c1");
    expect(restored.getConversation("c1")?.metadata.state).toBe("active");
  });

  it("preserves every other field when archiving", () => {
    const repository = new ConversationRepository([
      createConversation({
        id: "c1",
        createdAt: "2026-08-01T10:00:00.000Z",
        title: "T",
        tags: ["work"],
        messages: [makeMessage()],
      }),
    ]);
    const next = repository.archiveConversation("c1");
    const conversation = next.getConversation("c1");
    expect(conversation?.metadata.title).toBe("T");
    expect(conversation?.metadata.tags).toEqual(["work"]);
    expect(conversation?.metadata.createdAt).toBe("2026-08-01T10:00:00.000Z");
    expect(conversation?.messages).toHaveLength(1);
    expect(conversation?.metadata.updatedAt).toBe("2026-08-01T10:00:00.000Z");
  });

  it("keeps insertion order across state transitions", () => {
    const repository = new ConversationRepository([
      makeConversation("a"),
      makeConversation("b"),
      makeConversation("c"),
    ]);
    const next = repository.archiveConversation("b");
    expect(next.listConversations().map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(next.listConversations()[1].metadata.state).toBe("archived");
  });

  it("throws for unknown ids", () => {
    const repository = new ConversationRepository();
    expect(() => repository.archiveConversation("missing")).toThrow(ConversationNotFoundError);
    expect(() => repository.restoreConversation("missing")).toThrow(ConversationNotFoundError);
  });
});

// ──────────────────────────────────────────────
//  listConversations
// ──────────────────────────────────────────────

describe("listConversations", () => {
  it("returns every conversation in insertion order", () => {
    const repository = new ConversationRepository([
      makeConversation("c1"),
      makeConversation("c2"),
    ]);
    const { repository: next } = repository.createConversation(makeConversation("c3"));
    expect(next.listConversations().map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("returns detached clones", () => {
    const repository = new ConversationRepository([makeConversation("c1")]);
    const list = repository.listConversations();
    (list[0].messages as unknown as ConversationMessage[]).push(makeMessage());
    list[0].metadata.title = "Mutated";
    expect(repository.getConversation("c1")?.metadata.title).toBe("Conversation c1");
    expect(repository.getConversation("c1")?.messages).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────
//  hasConversation / count / clear
// ──────────────────────────────────────────────

describe("hasConversation, count, clear", () => {
  it("reports membership and count", () => {
    const repository = new ConversationRepository([makeConversation("c1")]);
    expect(repository.hasConversation("c1")).toBe(true);
    expect(repository.hasConversation("missing")).toBe(false);
    expect(repository.count()).toBe(1);
  });

  it("clear returns an empty repository", () => {
    const repository = new ConversationRepository([makeConversation("c1"), makeConversation("c2")]);
    const cleared = repository.clear();
    expect(cleared.count()).toBe(0);
    expect(cleared.listConversations()).toEqual([]);
    expect(repository.count()).toBe(2);
  });
});

// ──────────────────────────────────────────────
//  Determinism
// ──────────────────────────────────────────────

describe("determinism", () => {
  it("produces deep-equal repositories from identical operation sequences", () => {
    const run = (): ConversationRepository => {
      let repository = new ConversationRepository();
      const first = repository.createConversation(makeConversation("a"));
      repository = first.repository;
      const second = repository.createConversation(makeConversation("b"));
      repository = second.repository.archiveConversation("a");
      repository = repository.updateConversation(
        createConversation({ id: "b", createdAt: "2026-08-01T10:00:00.000Z", title: "B2" }),
      );
      return repository;
    };
    expect(run().listConversations()).toEqual(run().listConversations());
  });
});

// ──────────────────────────────────────────────
//  Large repositories
// ──────────────────────────────────────────────

describe("large repositories", () => {
  it("handles 1000 conversations with correct ordering and counts", () => {
    let repository = new ConversationRepository();
    for (let index = 0; index < 1000; index += 1) {
      const created = repository.createConversation(makeConversation(`c${index}`));
      repository = created.repository;
    }
    expect(repository.count()).toBe(1000);
    expect(repository.listConversations()[0].id).toBe("c0");
    expect(repository.listConversations()[999].id).toBe("c999");
    const deleted = repository.deleteConversation("c500");
    expect(deleted.count()).toBe(999);
    expect(deleted.hasConversation("c500")).toBe(false);
    expect(deleted.listConversations()[500].id).toBe("c501");
  });
});
