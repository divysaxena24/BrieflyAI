import { describe, it, expect, vi } from "vitest";
import {
  GmailServiceAdapter,
  type ProductionGmailService,
} from "@/lib/context/adapters/gmailServiceAdapter";
import { GmailSource } from "@/lib/context/sources/gmailSource";
import type { MessageSummary } from "@/lib/services/gmail/types";
import type { RetrievalQuery } from "@/lib/context/types";

/** Build a valid production MessageSummary fixture. */
function makeSummary(overrides: Partial<MessageSummary> = {}): MessageSummary {
  return {
    id: "msg-1",
    threadId: "thr-1",
    subject: "Interview Invitation",
    from: "alice@example.com",
    to: "me@example.com",
    date: "2026-08-08T10:00:00Z",
    snippet: "Your interview is scheduled for Monday.",
    labelIds: ["INBOX"],
    isUnread: true,
    ...overrides,
  };
}

/** Mock production GmailService with spy-able methods. */
interface MockProductionService extends ProductionGmailService {
  createClientForUser: ReturnType<typeof vi.fn>;
  listMessages: ReturnType<typeof vi.fn>;
  searchMessages: ReturnType<typeof vi.fn>;
}

function makeService(
  overrides: {
    messages?: MessageSummary[];
    availabilityError?: unknown;
    searchError?: unknown;
    listError?: unknown;
  } = {},
): MockProductionService {
  const service = {
    createClientForUser: vi.fn(async () => {
      if (overrides.availabilityError !== undefined) throw overrides.availabilityError;
      return { client: {}, integration: { id: "int-1" } };
    }),
    listMessages: vi.fn(async () => {
      if (overrides.listError !== undefined) throw overrides.listError;
      return { messages: overrides.messages ?? [], nextPageToken: null };
    }),
    searchMessages: vi.fn(async () => {
      if (overrides.searchError !== undefined) throw overrides.searchError;
      return { messages: overrides.messages ?? [], nextPageToken: null };
    }),
  };
  return service as unknown as MockProductionService;
}

describe("GmailServiceAdapter construction", () => {
  it("constructs with an injected mock production service", () => {
    const adapter = new GmailServiceAdapter(makeService());
    expect(adapter).toBeInstanceOf(GmailServiceAdapter);
  });

  it("constructs with the default production service (no arguments)", () => {
    const adapter = new GmailServiceAdapter();
    expect(adapter).toBeInstanceOf(GmailServiceAdapter);
  });

  it("stores the injected service and delegates to it", async () => {
    const service = makeService({ messages: [makeSummary()] });
    const adapter = new GmailServiceAdapter(service);
    const emails = await adapter.retrieveRelevantEmails({
      userId: "user-1",
      query: "interview",
      maxItems: 5,
    });
    expect(service.searchMessages).toHaveBeenCalled();
    expect(emails).toHaveLength(1);
  });
});

describe("GmailServiceAdapter isAvailable", () => {
  it("returns true when createClientForUser resolves", async () => {
    const adapter = new GmailServiceAdapter(makeService());
    await expect(adapter.isAvailable("user-1")).resolves.toBe(true);
  });

  it("returns false when createClientForUser rejects", async () => {
    const adapter = new GmailServiceAdapter(
      makeService({ availabilityError: new Error("google_not_connected") }),
    );
    await expect(adapter.isAvailable("user-1")).resolves.toBe(false);
  });

  it("delegates to createClientForUser (no extra logic)", async () => {
    const service = makeService();
    const adapter = new GmailServiceAdapter(service);
    await adapter.isAvailable("user-1");
    expect(service.createClientForUser).toHaveBeenCalledTimes(1);
    expect(service.createClientForUser).toHaveBeenCalledWith();
  });

  it("accepts a userId argument without error", async () => {
    const adapter = new GmailServiceAdapter(makeService());
    await expect(adapter.isAvailable("any-user-id")).resolves.toBe(true);
  });

  it("does not retry on failure (createClientForUser called exactly once)", async () => {
    const service = makeService({ availabilityError: new Error("down") });
    const adapter = new GmailServiceAdapter(service);
    await adapter.isAvailable("user-1");
    expect(service.createClientForUser).toHaveBeenCalledTimes(1);
  });

  it("does not cache: each call delegates again", async () => {
    const service = makeService();
    const adapter = new GmailServiceAdapter(service);
    await adapter.isAvailable("user-1");
    await adapter.isAvailable("user-1");
    expect(service.createClientForUser).toHaveBeenCalledTimes(2);
  });

  it("always resolves to a boolean (never rejects)", async () => {
    const service = makeService({ availabilityError: new Error("boom") });
    const adapter = new GmailServiceAdapter(service);
    await expect(adapter.isAvailable("user-1")).resolves.toBe(false);
  });
});

describe("GmailServiceAdapter retrieveRelevantEmails delegation", () => {
  it("delegates a non-empty query to searchMessages with (query, maxItems)", async () => {
    const service = makeService({ messages: [makeSummary()] });
    const adapter = new GmailServiceAdapter(service);
    await adapter.retrieveRelevantEmails({ userId: "u", query: "interview", maxItems: 5 });
    expect(service.searchMessages).toHaveBeenCalledWith("interview", 5);
    expect(service.listMessages).not.toHaveBeenCalled();
  });

  it("delegates an empty query to listMessages with { maxResults }", async () => {
    const service = makeService({ messages: [makeSummary()] });
    const adapter = new GmailServiceAdapter(service);
    await adapter.retrieveRelevantEmails({ userId: "u", query: "", maxItems: 5 });
    expect(service.listMessages).toHaveBeenCalledWith({ maxResults: 5 });
    expect(service.searchMessages).not.toHaveBeenCalled();
  });

  it("delegates a blank/whitespace-only query to listMessages", async () => {
    const service = makeService();
    const adapter = new GmailServiceAdapter(service);
    await adapter.retrieveRelevantEmails({ userId: "u", query: "   ", maxItems: 3 });
    expect(service.listMessages).toHaveBeenCalledWith({ maxResults: 3 });
    expect(service.searchMessages).not.toHaveBeenCalled();
  });

  it("forwards a missing maxItems as undefined to searchMessages", async () => {
    const service = makeService();
    const adapter = new GmailServiceAdapter(service);
    await adapter.retrieveRelevantEmails({ userId: "u", query: "interview" });
    expect(service.searchMessages).toHaveBeenCalledWith("interview", undefined);
  });

  it("forwards a missing maxItems as undefined to listMessages", async () => {
    const service = makeService();
    const adapter = new GmailServiceAdapter(service);
    await adapter.retrieveRelevantEmails({ userId: "u", query: "" });
    expect(service.listMessages).toHaveBeenCalledWith({ maxResults: undefined });
  });

  it("passes a padded query verbatim to searchMessages (no trimming)", async () => {
    const service = makeService();
    const adapter = new GmailServiceAdapter(service);
    await adapter.retrieveRelevantEmails({ userId: "u", query: "  interview  ", maxItems: 2 });
    expect(service.searchMessages).toHaveBeenCalledWith("  interview  ", 2);
  });

  it("accepts a history option without error", async () => {
    const service = makeService();
    const adapter = new GmailServiceAdapter(service);
    await expect(
      adapter.retrieveRelevantEmails({
        userId: "u",
        query: "interview",
        history: ["User: hi", "Assistant: hello"],
        maxItems: 5,
      }),
    ).resolves.toEqual([]);
  });

  it("preserves the production ordering without filtering or reranking", async () => {
    const messages = [makeSummary({ id: "a" }), makeSummary({ id: "b" }), makeSummary({ id: "c" })];
    const adapter = new GmailServiceAdapter(makeService({ messages }));
    const emails = await adapter.retrieveRelevantEmails({ userId: "u", query: "q", maxItems: 10 });
    expect(emails.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });
});

describe("GmailServiceAdapter mapping", () => {
  it("maps every compatible field", async () => {
    const message = makeSummary();
    const adapter = new GmailServiceAdapter(makeService({ messages: [message] }));
    const [email] = await adapter.retrieveRelevantEmails({ userId: "u", query: "q" });
    expect(email).toEqual({
      id: "msg-1",
      subject: "Interview Invitation",
      body: "Your interview is scheduled for Monday.",
      timestamp: "2026-08-08T10:00:00Z",
      threadId: "thr-1",
      author: "alice@example.com",
    });
  });

  it("maps subject and snippet to subject and body", async () => {
    const adapter = new GmailServiceAdapter(
      makeService({ messages: [makeSummary({ subject: "Subject line", snippet: "Body text" })] }),
    );
    const [email] = await adapter.retrieveRelevantEmails({ userId: "u", query: "q" });
    expect(email.subject).toBe("Subject line");
    expect(email.body).toBe("Body text");
  });

  it("normalizes a null subject to an empty string", async () => {
    const adapter = new GmailServiceAdapter(makeService({ messages: [makeSummary({ subject: null })] }));
    const [email] = await adapter.retrieveRelevantEmails({ userId: "u", query: "q" });
    expect(email.subject).toBe("");
  });

  it("normalizes a null snippet to an empty body", async () => {
    const adapter = new GmailServiceAdapter(makeService({ messages: [makeSummary({ snippet: null })] }));
    const [email] = await adapter.retrieveRelevantEmails({ userId: "u", query: "q" });
    expect(email.body).toBe("");
  });

  it("maps date to timestamp", async () => {
    const adapter = new GmailServiceAdapter(
      makeService({ messages: [makeSummary({ date: "2026-08-01T09:30:00Z" })] }),
    );
    const [email] = await adapter.retrieveRelevantEmails({ userId: "u", query: "q" });
    expect(email.timestamp).toBe("2026-08-01T09:30:00Z");
  });

  it("maps a null date to an undefined timestamp", async () => {
    const adapter = new GmailServiceAdapter(makeService({ messages: [makeSummary({ date: null })] }));
    const [email] = await adapter.retrieveRelevantEmails({ userId: "u", query: "q" });
    expect(email.timestamp).toBeUndefined();
  });

  it("maps from to author", async () => {
    const adapter = new GmailServiceAdapter(
      makeService({ messages: [makeSummary({ from: "bob@example.com" })] }),
    );
    const [email] = await adapter.retrieveRelevantEmails({ userId: "u", query: "q" });
    expect(email.author).toBe("bob@example.com");
  });

  it("maps a null from to an undefined author", async () => {
    const adapter = new GmailServiceAdapter(makeService({ messages: [makeSummary({ from: null })] }));
    const [email] = await adapter.retrieveRelevantEmails({ userId: "u", query: "q" });
    expect(email.author).toBeUndefined();
  });

  it("maps threadId", async () => {
    const adapter = new GmailServiceAdapter(
      makeService({ messages: [makeSummary({ threadId: "thread-9" })] }),
    );
    const [email] = await adapter.retrieveRelevantEmails({ userId: "u", query: "q" });
    expect(email.threadId).toBe("thread-9");
  });

  it("never invents a relevance score (omitted)", async () => {
    const adapter = new GmailServiceAdapter(makeService({ messages: [makeSummary()] }));
    const [email] = await adapter.retrieveRelevantEmails({ userId: "u", query: "q" });
    expect(email.relevance).toBeUndefined();
  });

  it("never invents an importance level (omitted)", async () => {
    const adapter = new GmailServiceAdapter(makeService({ messages: [makeSummary()] }));
    const [email] = await adapter.retrieveRelevantEmails({ userId: "u", query: "q" });
    expect(email.importance).toBeUndefined();
  });

  it("returns new email objects (not the production summary references)", async () => {
    const message = makeSummary();
    const adapter = new GmailServiceAdapter(makeService({ messages: [message] }));
    const [email] = await adapter.retrieveRelevantEmails({ userId: "u", query: "q" });
    expect(email).not.toBe(message);
  });

  it("does not mutate the production summary objects", async () => {
    const message = makeSummary();
    const snapshot = JSON.parse(JSON.stringify(message)) as MessageSummary;
    const adapter = new GmailServiceAdapter(makeService({ messages: [message] }));
    await adapter.retrieveRelevantEmails({ userId: "u", query: "q" });
    expect(message).toEqual(snapshot);
  });
});

describe("GmailServiceAdapter responses", () => {
  it("returns an empty list for an empty production response", async () => {
    const adapter = new GmailServiceAdapter(makeService({ messages: [] }));
    await expect(
      adapter.retrieveRelevantEmails({ userId: "u", query: "q" }),
    ).resolves.toEqual([]);
  });

  it("maps multiple emails preserving order", async () => {
    const messages = [
      makeSummary({ id: "m1" }),
      makeSummary({ id: "m2" }),
      makeSummary({ id: "m3" }),
    ];
    const adapter = new GmailServiceAdapter(makeService({ messages }));
    const emails = await adapter.retrieveRelevantEmails({ userId: "u", query: "q" });
    expect(emails.map((e) => e.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("handles a large production response", async () => {
    const messages = Array.from({ length: 1000 }, (_, i) => makeSummary({ id: `msg-${i}` }));
    const adapter = new GmailServiceAdapter(makeService({ messages }));
    const emails = await adapter.retrieveRelevantEmails({ userId: "u", query: "q" });
    expect(emails).toHaveLength(1000);
    expect(emails[999].id).toBe("msg-999");
  });

  it("is deterministic across repeated calls", async () => {
    const messages = [makeSummary({ id: "a" }), makeSummary({ id: "b" })];
    const adapter = new GmailServiceAdapter(makeService({ messages }));
    const options = { userId: "u", query: "q" };
    const first = await adapter.retrieveRelevantEmails(options);
    const second = await adapter.retrieveRelevantEmails(options);
    expect(second).toEqual(first);
  });
});

describe("GmailServiceAdapter error propagation", () => {
  it("forwards an async searchMessages rejection (never swallowed)", async () => {
    const error = new Error("gmail search down");
    const adapter = new GmailServiceAdapter(makeService({ searchError: error }));
    await expect(
      adapter.retrieveRelevantEmails({ userId: "u", query: "q" }),
    ).rejects.toBe(error);
  });

  it("forwards an async listMessages rejection (never swallowed)", async () => {
    const error = new Error("gmail list down");
    const adapter = new GmailServiceAdapter(makeService({ listError: error }));
    await expect(
      adapter.retrieveRelevantEmails({ userId: "u", query: "" }),
    ).rejects.toBe(error);
  });

  it("forwards a synchronous searchMessages throw", async () => {
    const error = new Error("sync boom");
    const service = makeService();
    service.searchMessages.mockImplementation(() => {
      throw error;
    });
    const adapter = new GmailServiceAdapter(service);
    await expect(
      adapter.retrieveRelevantEmails({ userId: "u", query: "q" }),
    ).rejects.toBe(error);
  });

  it("forwards a synchronous listMessages throw", async () => {
    const error = new Error("sync list boom");
    const service = makeService();
    service.listMessages.mockImplementation(() => {
      throw error;
    });
    const adapter = new GmailServiceAdapter(service);
    await expect(
      adapter.retrieveRelevantEmails({ userId: "u", query: "" }),
    ).rejects.toBe(error);
  });
});

describe("GmailServiceAdapter retry behavior", () => {
  it("calls searchMessages exactly once on success", async () => {
    const service = makeService({ messages: [makeSummary()] });
    const adapter = new GmailServiceAdapter(service);
    await adapter.retrieveRelevantEmails({ userId: "u", query: "q" });
    expect(service.searchMessages).toHaveBeenCalledTimes(1);
  });

  it("calls listMessages exactly once on success", async () => {
    const service = makeService({ messages: [makeSummary()] });
    const adapter = new GmailServiceAdapter(service);
    await adapter.retrieveRelevantEmails({ userId: "u", query: "" });
    expect(service.listMessages).toHaveBeenCalledTimes(1);
  });

  it("never retries a failing search (single delegation)", async () => {
    const service = makeService({ searchError: new Error("down") });
    const adapter = new GmailServiceAdapter(service);
    await adapter.retrieveRelevantEmails({ userId: "u", query: "q" }).catch(() => undefined);
    expect(service.searchMessages).toHaveBeenCalledTimes(1);
  });
});

describe("GmailServiceAdapter immutability", () => {
  it("does not mutate the options object passed to retrieveRelevantEmails", async () => {
    const service = makeService({ messages: [makeSummary()] });
    const adapter = new GmailServiceAdapter(service);
    const options = { userId: "u", query: "interview", history: ["hi"], maxItems: 5 };
    const snapshot = { ...options };
    await adapter.retrieveRelevantEmails(options);
    expect(options).toEqual(snapshot);
  });

  it("does not mutate the production messages array", async () => {
    const messages = [makeSummary({ id: "a" }), makeSummary({ id: "b" })];
    const snapshot = JSON.parse(JSON.stringify(messages)) as MessageSummary[];
    const adapter = new GmailServiceAdapter(makeService({ messages }));
    await adapter.retrieveRelevantEmails({ userId: "u", query: "q" });
    expect(messages).toEqual(snapshot);
  });
});

describe("GmailServiceAdapter GmailSource integration", () => {
  it("satisfies the GmailSource contract end-to-end", async () => {
    const service = makeService({
      messages: [makeSummary({ id: "m1", subject: "Hello", snippet: "Body here" })],
    });
    const adapter = new GmailServiceAdapter(service);
    const source = new GmailSource(adapter);
    const query: RetrievalQuery = { userId: "user-1", query: "hello" };
    const contexts = await source.retrieve(query);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      id: "m1",
      source: "gmail",
      title: "Hello",
      content: "Body here",
    });
    expect(service.searchMessages).toHaveBeenCalledWith("hello", undefined);
  });

  it("drives GmailSource isAvailable through the adapter", async () => {
    const adapter = new GmailServiceAdapter(makeService());
    const source = new GmailSource(adapter);
    await expect(source.isAvailable("user-1")).resolves.toBe(true);
  });

  it("reports unavailability through GmailSource when the service rejects", async () => {
    const adapter = new GmailServiceAdapter(
      makeService({ availabilityError: new Error("not connected") }),
    );
    const source = new GmailSource(adapter);
    await expect(source.isAvailable("user-1")).resolves.toBe(false);
  });

  it("defaults relevance to 0.5 downstream when the adapter omits it", async () => {
    const adapter = new GmailServiceAdapter(makeService({ messages: [makeSummary()] }));
    const source = new GmailSource(adapter);
    const contexts = await source.retrieve({ userId: "u", query: "q" });
    expect(contexts[0].relevance).toBe(0.5);
  });
});
