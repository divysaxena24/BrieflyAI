import { describe, it, expect, vi } from "vitest";
import { GitHubSource } from "@/lib/context/sources/githubSource";
import { ContextSourceBase } from "@/lib/context/sources/contextSource";
import { estimateTokens } from "@/lib/context/tokenBudget";
import type { GitHubItem, GitHubService } from "@/lib/context/sources/githubSource";
import type { RetrievalQuery } from "@/lib/context/types";

/** Build a valid GitHubItem fixture (an issue by default). */
function makeItem(overrides: Partial<GitHubItem> = {}): GitHubItem {
  return {
    id: "gh-1",
    title: "Fix login redirect bug",
    content: "The login flow redirects to the wrong page after auth.",
    timestamp: "2026-08-07T14:22:00Z",
    relevance: 0.9,
    repository: "acme/app",
    issueNumber: 42,
    author: "dev@example.com",
    importance: "high",
    ...overrides,
  };
}

/** Build a valid RetrievalQuery fixture. */
function makeQuery(overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    userId: "user-1",
    query: "login bug",
    history: ["User: hi", "Assistant: hello"],
    maxItems: 5,
    ...overrides,
  };
}

interface MockService extends GitHubService {
  isAvailable: ReturnType<typeof vi.fn>;
  retrieveRelevantItems: ReturnType<typeof vi.fn>;
}

/** Build a fully mocked GitHubService. */
function makeService(
  overrides: { available?: boolean; items?: GitHubItem[]; error?: unknown } = {},
): MockService {
  const service = {
    isAvailable: vi.fn(async (): Promise<boolean> => {
      if (overrides.error !== undefined) throw overrides.error;
      return overrides.available ?? true;
    }),
    retrieveRelevantItems: vi.fn(async (): Promise<GitHubItem[]> => {
      if (overrides.error !== undefined) throw overrides.error;
      return overrides.items ?? [];
    }),
  };
  return service as unknown as MockService;
}

describe("GitHubSource identity", () => {
  it("exposes the id 'github'", () => {
    expect(new GitHubSource(makeService()).id).toBe("github");
  });

  it("exposes priority 40", () => {
    expect(new GitHubSource(makeService()).priority).toBe(40);
  });

  it("extends ContextSourceBase", () => {
    expect(new GitHubSource(makeService())).toBeInstanceOf(ContextSourceBase);
  });

  it("stores the injected service for later calls", async () => {
    const service = makeService({ items: [makeItem()] });
    const source = new GitHubSource(service);
    const contexts = await source.retrieve(makeQuery());
    expect(service.retrieveRelevantItems).toHaveBeenCalled();
    expect(contexts).toHaveLength(1);
  });
});

describe("GitHubSource isAvailable", () => {
  it("forwards true from the service", async () => {
    const service = makeService({ available: true });
    const source = new GitHubSource(service);
    await expect(source.isAvailable("user-1")).resolves.toBe(true);
    expect(service.isAvailable).toHaveBeenCalledWith("user-1");
  });

  it("forwards false from the service", async () => {
    const source = new GitHubSource(makeService({ available: false }));
    await expect(source.isAvailable("user-9")).resolves.toBe(false);
  });

  it("passes the exact userId through", async () => {
    const service = makeService();
    const source = new GitHubSource(service);
    await source.isAvailable("some-user-id");
    expect(service.isAvailable).toHaveBeenCalledWith("some-user-id");
  });

  it("propagates a service rejection (no try/catch in isAvailable)", async () => {
    const error = new Error("github service down");
    const source = new GitHubSource(makeService({ error }));
    await expect(source.isAvailable("user-1")).rejects.toBe(error);
  });
});

describe("GitHubSource retrieve service call", () => {
  it("forwards the exact arguments", async () => {
    const service = makeService();
    const source = new GitHubSource(service);
    const query = makeQuery();
    await source.retrieve(query);
    expect(service.retrieveRelevantItems).toHaveBeenCalledWith({
      userId: "user-1",
      query: "login bug",
      history: ["User: hi", "Assistant: hello"],
      maxItems: 5,
    });
  });

  it("forwards missing history as undefined", async () => {
    const service = makeService();
    const source = new GitHubSource(service);
    await source.retrieve(makeQuery({ history: undefined }));
    expect(service.retrieveRelevantItems).toHaveBeenCalledWith({
      userId: "user-1",
      query: "login bug",
      history: undefined,
      maxItems: 5,
    });
  });

  it("forwards missing maxItems as undefined", async () => {
    const service = makeService();
    const source = new GitHubSource(service);
    await source.retrieve(makeQuery({ maxItems: undefined }));
    expect(service.retrieveRelevantItems).toHaveBeenCalledWith({
      userId: "user-1",
      query: "login bug",
      history: ["User: hi", "Assistant: hello"],
      maxItems: undefined,
    });
  });

  it("returns an empty array for an empty item list", async () => {
    const source = new GitHubSource(makeService({ items: [] }));
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });

  it("maps multiple items", async () => {
    const items = [makeItem({ id: "a" }), makeItem({ id: "b" }), makeItem({ id: "c" })];
    const source = new GitHubSource(makeService({ items }));
    const contexts = await source.retrieve(makeQuery());
    expect(contexts).toHaveLength(3);
    expect(contexts.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("preserves the service's ordering", async () => {
    const items = [
      makeItem({ id: "first", relevance: 0.9 }),
      makeItem({ id: "second", relevance: 0.4 }),
      makeItem({ id: "third", relevance: 0.1 }),
    ];
    const source = new GitHubSource(makeService({ items }));
    const contexts = await source.retrieve(makeQuery());
    expect(contexts.map((c) => c.id)).toEqual(["first", "second", "third"]);
  });

  it("is deterministic across repeated calls", async () => {
    const items = [makeItem({ id: "a" }), makeItem({ id: "b" })];
    const source = new GitHubSource(makeService({ items }));
    const first = await source.retrieve(makeQuery());
    const second = await source.retrieve(makeQuery());
    expect(second).toEqual(first);
  });
});

describe("GitHubSource Context mapping", () => {
  it("maps every field of an item to a Context", async () => {
    const item = makeItem();
    const source = new GitHubSource(makeService({ items: [item] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context).toMatchObject({
      id: "gh-1",
      source: "github",
      title: "Fix login redirect bug",
      content: "The login flow redirects to the wrong page after auth.",
      timestamp: "2026-08-07T14:22:00Z",
      relevance: 0.9,
      truncated: false,
      compressed: false,
      permissions: null,
    });
  });

  it("maps the title", async () => {
    const source = new GitHubSource(makeService({ items: [makeItem({ title: "PR #9" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.title).toBe("PR #9");
  });

  it("maps the content", async () => {
    const source = new GitHubSource(makeService({ items: [makeItem({ content: "Body text" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.content).toBe("Body text");
  });

  it("sets source to 'github'", async () => {
    const source = new GitHubSource(makeService({ items: [makeItem()] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.source).toBe("github");
  });

  it("computes tokenEstimate with estimateTokens(content)", async () => {
    const item = makeItem({ content: "short body" });
    const source = new GitHubSource(makeService({ items: [item] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.tokenEstimate).toBe(estimateTokens("short body"));
    expect(context.tokenEstimate).toBe(Math.ceil("short body".length / 4));
  });

  it("maps a provided timestamp verbatim", async () => {
    const source = new GitHubSource(
      makeService({ items: [makeItem({ timestamp: "2026-08-02T10:00:00Z" })] }),
    );
    const [context] = await source.retrieve(makeQuery());
    expect(context.timestamp).toBe("2026-08-02T10:00:00Z");
  });

  it("maps a missing timestamp (undefined) to null", async () => {
    const source = new GitHubSource(makeService({ items: [makeItem({ timestamp: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.timestamp).toBeNull();
  });

  it("maps a null timestamp to null", async () => {
    const source = new GitHubSource(makeService({ items: [makeItem({ timestamp: null })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.timestamp).toBeNull();
  });

  it("defaults relevance to 0.5 when missing", async () => {
    const source = new GitHubSource(makeService({ items: [makeItem({ relevance: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.relevance).toBe(0.5);
  });

  it("keeps an explicit relevance score", async () => {
    const source = new GitHubSource(makeService({ items: [makeItem({ relevance: 0.3 })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.relevance).toBe(0.3);
  });

  it("sets metadata.kind to 'github'", async () => {
    const source = new GitHubSource(makeService({ items: [makeItem()] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.kind).toBe("github");
  });

  it("sets metadata.entityId to the item id", async () => {
    const source = new GitHubSource(makeService({ items: [makeItem({ id: "gh-42" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.entityId).toBe("gh-42");
  });

  it("maps metadata.repository", async () => {
    const source = new GitHubSource(makeService({ items: [makeItem({ repository: "acme/api" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.repository).toBe("acme/api");
  });

  it("leaves metadata.repository undefined when absent", async () => {
    const source = new GitHubSource(makeService({ items: [makeItem({ repository: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.repository).toBeUndefined();
  });

  it("maps metadata.issueNumber", async () => {
    const source = new GitHubSource(makeService({ items: [makeItem({ issueNumber: 7 })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.issueNumber).toBe(7);
  });

  it("leaves metadata.issueNumber undefined when the item is not an issue", async () => {
    const source = new GitHubSource(makeService({ items: [makeItem({ issueNumber: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.issueNumber).toBeUndefined();
  });

  it("maps metadata.pullRequestNumber", async () => {
    const source = new GitHubSource(
      makeService({ items: [makeItem({ pullRequestNumber: 12 })] }),
    );
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.pullRequestNumber).toBe(12);
  });

  it("leaves metadata.pullRequestNumber undefined when the item is not a PR", async () => {
    const source = new GitHubSource(
      makeService({ items: [makeItem({ pullRequestNumber: undefined })] }),
    );
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.pullRequestNumber).toBeUndefined();
  });

  it("maps metadata.author", async () => {
    const source = new GitHubSource(makeService({ items: [makeItem({ author: "bob@x.com" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.author).toBe("bob@x.com");
  });

  it("maps metadata.importance", async () => {
    const source = new GitHubSource(makeService({ items: [makeItem({ importance: "critical" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.importance).toBe("critical");
  });

  it("omits importance when the item has none", async () => {
    const source = new GitHubSource(makeService({ items: [makeItem({ importance: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.importance).toBeUndefined();
  });

  it("stores the original item object in metadata.raw by reference", async () => {
    const item = makeItem({ content: "unique raw payload" });
    const source = new GitHubSource(makeService({ items: [item] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.raw).toBe(item);
  });

  it("sets permissions to null", async () => {
    const source = new GitHubSource(makeService({ items: [makeItem()] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.permissions).toBeNull();
  });

  it("marks the context as neither truncated nor compressed", async () => {
    const source = new GitHubSource(makeService({ items: [makeItem()] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.truncated).toBe(false);
    expect(context.compressed).toBe(false);
  });
});

describe("GitHubSource error handling", () => {
  it("returns [] when the service rejects asynchronously", async () => {
    const source = new GitHubSource(makeService({ error: new Error("service boom") }));
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });

  it("returns [] when the service throws synchronously", async () => {
    const service = {
      isAvailable: vi.fn(async () => true),
      retrieveRelevantItems: vi.fn((): Promise<GitHubItem[]> => {
        throw new Error("sync boom");
      }),
    } as unknown as GitHubService;
    const source = new GitHubSource(service);
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });

  it("never throws for a failing service", async () => {
    const source = new GitHubSource(makeService({ error: new Error("down") }));
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });
});

describe("GitHubSource immutability", () => {
  it("does not mutate the retrieval query", async () => {
    const query = makeQuery();
    const snapshot = JSON.parse(JSON.stringify(query)) as RetrievalQuery;
    const source = new GitHubSource(makeService({ items: [makeItem()] }));
    await source.retrieve(query);
    expect(query).toEqual(snapshot);
  });

  it("does not mutate the source item objects", async () => {
    const item = makeItem({ content: "original" });
    const snapshot = JSON.parse(JSON.stringify(item)) as GitHubItem;
    const source = new GitHubSource(makeService({ items: [item] }));
    await source.retrieve(makeQuery());
    expect(item).toEqual(snapshot);
  });

  it("returns new Context objects (not the item references)", async () => {
    const item = makeItem();
    const source = new GitHubSource(makeService({ items: [item] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context).not.toBe(item);
  });

  it("preserves the raw reference to the original item", async () => {
    const item = makeItem();
    const source = new GitHubSource(makeService({ items: [item] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.raw).toBe(item);
  });
});
