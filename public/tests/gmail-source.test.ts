import { describe, it, expect, vi } from "vitest";
import { GmailSource } from "@/lib/context/sources/gmailSource";
import { ContextSourceBase } from "@/lib/context/sources/contextSource";
import { estimateTokens } from "@/lib/context/tokenBudget";
import type { GmailEmail, GmailService } from "@/lib/context/sources/gmailSource";
import type { RetrievalQuery } from "@/lib/context/types";

/** Build a valid GmailEmail fixture. */
function makeEmail(overrides: Partial<GmailEmail> = {}): GmailEmail {
  return {
    id: "email-1",
    subject: "Interview Invitation",
    body: "Your interview is scheduled for Monday at 10am.",
    timestamp: "2026-08-08T10:00:00Z",
    relevance: 0.9,
    threadId: "thread-1",
    author: "alice@example.com",
    importance: "high",
    ...overrides,
  };
}

/** Build a valid RetrievalQuery fixture. */
function makeQuery(overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    userId: "user-1",
    query: "interview emails",
    history: ["User: hi", "Assistant: hello"],
    maxItems: 5,
    ...overrides,
  };
}

interface MockService extends GmailService {
  isAvailable: ReturnType<typeof vi.fn>;
  retrieveRelevantEmails: ReturnType<typeof vi.fn>;
}

/** Build a fully mocked GmailService. */
function makeService(
  overrides: { available?: boolean; emails?: GmailEmail[]; error?: unknown } = {},
): MockService {
  const service = {
    isAvailable: vi.fn(async (): Promise<boolean> => {
      if (overrides.error !== undefined) throw overrides.error;
      return overrides.available ?? true;
    }),
    retrieveRelevantEmails: vi.fn(async (): Promise<GmailEmail[]> => {
      if (overrides.error !== undefined) throw overrides.error;
      return overrides.emails ?? [];
    }),
  };
  return service as unknown as MockService;
}

describe("GmailSource identity", () => {
  it("exposes the id 'gmail'", () => {
    expect(new GmailSource(makeService()).id).toBe("gmail");
  });

  it("exposes priority 80", () => {
    expect(new GmailSource(makeService()).priority).toBe(80);
  });

  it("extends ContextSourceBase", () => {
    expect(new GmailSource(makeService())).toBeInstanceOf(ContextSourceBase);
  });

  it("stores the injected service for later calls", async () => {
    const service = makeService({ emails: [makeEmail()] });
    const source = new GmailSource(service);
    const contexts = await source.retrieve(makeQuery());
    expect(service.retrieveRelevantEmails).toHaveBeenCalled();
    expect(contexts).toHaveLength(1);
  });
});

describe("GmailSource isAvailable", () => {
  it("forwards to the gmail service", async () => {
    const service = makeService({ available: true });
    const source = new GmailSource(service);
    await expect(source.isAvailable("user-1")).resolves.toBe(true);
    expect(service.isAvailable).toHaveBeenCalledWith("user-1");
  });

  it("returns false when the service reports unavailable", async () => {
    const source = new GmailSource(makeService({ available: false }));
    await expect(source.isAvailable("user-9")).resolves.toBe(false);
  });

  it("passes the exact userId through", async () => {
    const service = makeService();
    const source = new GmailSource(service);
    await source.isAvailable("some-user-id");
    expect(service.isAvailable).toHaveBeenCalledWith("some-user-id");
  });

  it("propagates a service rejection (no extra logic in isAvailable)", async () => {
    const error = new Error("gmail service down");
    const source = new GmailSource(makeService({ error }));
    await expect(source.isAvailable("user-1")).rejects.toBe(error);
  });
});

describe("GmailSource retrieve service call", () => {
  it("calls retrieveRelevantEmails with the query fields", async () => {
    const service = makeService();
    const source = new GmailSource(service);
    const query = makeQuery();
    await source.retrieve(query);
    expect(service.retrieveRelevantEmails).toHaveBeenCalledWith({
      userId: "user-1",
      query: "interview emails",
      history: ["User: hi", "Assistant: hello"],
      maxItems: 5,
    });
  });

  it("forwards missing optional fields as undefined", async () => {
    const service = makeService();
    const source = new GmailSource(service);
    await source.retrieve(makeQuery({ history: undefined, maxItems: undefined }));
    expect(service.retrieveRelevantEmails).toHaveBeenCalledWith({
      userId: "user-1",
      query: "interview emails",
      history: undefined,
      maxItems: undefined,
    });
  });
});

describe("GmailSource Context mapping", () => {
  it("maps every field of an email to a Context", async () => {
    const email = makeEmail();
    const source = new GmailSource(makeService({ emails: [email] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context).toMatchObject({
      id: "email-1",
      source: "gmail",
      title: "Interview Invitation",
      content: "Your interview is scheduled for Monday at 10am.",
      timestamp: "2026-08-08T10:00:00Z",
      relevance: 0.9,
      truncated: false,
      compressed: false,
      permissions: null,
    });
  });

  it("sets source to 'gmail'", async () => {
    const source = new GmailSource(makeService({ emails: [makeEmail()] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.source).toBe("gmail");
  });

  it("maps the subject to title and body to content", async () => {
    const source = new GmailSource(
      makeService({ emails: [makeEmail({ subject: "Subject line", body: "Body text" })] }),
    );
    const [context] = await source.retrieve(makeQuery());
    expect(context.title).toBe("Subject line");
    expect(context.content).toBe("Body text");
  });

  it("computes tokenEstimate with estimateTokens(body)", async () => {
    const email = makeEmail({ body: "short body" });
    const source = new GmailSource(makeService({ emails: [email] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.tokenEstimate).toBe(estimateTokens("short body"));
    expect(context.tokenEstimate).toBe(Math.ceil("short body".length / 4));
  });

  it("estimates tokens for an empty body as 0", async () => {
    const source = new GmailSource(makeService({ emails: [makeEmail({ body: "" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.tokenEstimate).toBe(0);
  });

  it("maps a null timestamp to null", async () => {
    const source = new GmailSource(makeService({ emails: [makeEmail({ timestamp: null })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.timestamp).toBeNull();
  });

  it("maps a missing timestamp (undefined) to null", async () => {
    const source = new GmailSource(makeService({ emails: [makeEmail({ timestamp: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.timestamp).toBeNull();
  });

  it("keeps a provided timestamp verbatim", async () => {
    const source = new GmailSource(
      makeService({ emails: [makeEmail({ timestamp: "2026-08-02T10:00:00Z" })] }),
    );
    const [context] = await source.retrieve(makeQuery());
    expect(context.timestamp).toBe("2026-08-02T10:00:00Z");
  });

  it("defaults relevance to 0.5 when missing", async () => {
    const source = new GmailSource(makeService({ emails: [makeEmail({ relevance: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.relevance).toBe(0.5);
  });

  it("keeps an explicit relevance score", async () => {
    const source = new GmailSource(makeService({ emails: [makeEmail({ relevance: 0.3 })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.relevance).toBe(0.3);
  });

  it("sets metadata.kind to 'email' and entityId to the email id", async () => {
    const source = new GmailSource(makeService({ emails: [makeEmail({ id: "email-42" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.kind).toBe("email");
    expect(context.metadata.entityId).toBe("email-42");
  });

  it("maps metadata.threadId from the email", async () => {
    const source = new GmailSource(makeService({ emails: [makeEmail({ threadId: "t-9" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.threadId).toBe("t-9");
  });

  it("leaves metadata.threadId undefined when the email has none", async () => {
    const source = new GmailSource(makeService({ emails: [makeEmail({ threadId: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.threadId).toBeUndefined();
  });

  it("maps metadata.author from the email", async () => {
    const source = new GmailSource(makeService({ emails: [makeEmail({ author: "bob@x.com" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.author).toBe("bob@x.com");
  });

  it("maps metadata.importance from the email", async () => {
    const source = new GmailSource(makeService({ emails: [makeEmail({ importance: "critical" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.importance).toBe("critical");
  });

  it("omits importance when the email has none", async () => {
    const source = new GmailSource(makeService({ emails: [makeEmail({ importance: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.importance).toBeUndefined();
  });

  it("stores the original email object in metadata.raw", async () => {
    const email = makeEmail({ body: "unique raw payload", importance: "low" });
    const source = new GmailSource(makeService({ emails: [email] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.raw).toBe(email);
  });

  it("sets permissions to null", async () => {
    const source = new GmailSource(makeService({ emails: [makeEmail()] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.permissions).toBeNull();
  });

  it("marks the context as neither truncated nor compressed", async () => {
    const source = new GmailSource(makeService({ emails: [makeEmail()] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.truncated).toBe(false);
    expect(context.compressed).toBe(false);
  });
});

describe("GmailSource error handling", () => {
  it("returns [] when the service rejects", async () => {
    const source = new GmailSource(makeService({ error: new Error("service boom") }));
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });

  it("returns [] when the service throws synchronously", async () => {
    const service = {
      isAvailable: vi.fn(async () => true),
      retrieveRelevantEmails: vi.fn((): Promise<GmailEmail[]> => {
        throw new Error("sync boom");
      }),
    } as unknown as GmailService;
    const source = new GmailSource(service);
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });

  it("never throws for a failing service", async () => {
    const source = new GmailSource(makeService({ error: new Error("down") }));
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });
});

describe("GmailSource result behavior", () => {
  it("returns an empty array for an empty email list", async () => {
    const source = new GmailSource(makeService({ emails: [] }));
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });

  it("maps multiple emails", async () => {
    const emails = [makeEmail({ id: "a" }), makeEmail({ id: "b" }), makeEmail({ id: "c" })];
    const source = new GmailSource(makeService({ emails }));
    const contexts = await source.retrieve(makeQuery());
    expect(contexts).toHaveLength(3);
    expect(contexts.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("preserves the service's ordering", async () => {
    const emails = [
      makeEmail({ id: "first", relevance: 0.9 }),
      makeEmail({ id: "second", relevance: 0.4 }),
      makeEmail({ id: "third", relevance: 0.1 }),
    ];
    const source = new GmailSource(makeService({ emails }));
    const contexts = await source.retrieve(makeQuery());
    expect(contexts.map((c) => c.id)).toEqual(["first", "second", "third"]);
  });

  it("is deterministic across repeated calls", async () => {
    const emails = [makeEmail({ id: "a" }), makeEmail({ id: "b" })];
    const source = new GmailSource(makeService({ emails }));
    const first = await source.retrieve(makeQuery());
    const second = await source.retrieve(makeQuery());
    expect(second).toEqual(first);
  });
});

describe("GmailSource immutability", () => {
  it("does not mutate the retrieval query", async () => {
    const query = makeQuery();
    const snapshot = JSON.parse(JSON.stringify(query)) as RetrievalQuery;
    const source = new GmailSource(makeService({ emails: [makeEmail()] }));
    await source.retrieve(query);
    expect(query).toEqual(snapshot);
  });

  it("does not mutate the email objects", async () => {
    const email = makeEmail({ body: "original" });
    const snapshot = JSON.parse(JSON.stringify(email)) as GmailEmail;
    const source = new GmailSource(makeService({ emails: [email] }));
    await source.retrieve(makeQuery());
    expect(email).toEqual(snapshot);
  });

  it("returns new Context objects (not the email references)", async () => {
    const email = makeEmail();
    const source = new GmailSource(makeService({ emails: [email] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context).not.toBe(email);
    expect(context.metadata.raw).toBe(email);
  });
});
