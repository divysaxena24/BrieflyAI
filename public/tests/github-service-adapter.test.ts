import { describe, it, expect, vi } from "vitest";
import {
  GitHubServiceAdapter,
  type ProductionGitHubService,
} from "@/lib/context/adapters/githubServiceAdapter";
import { GitHubSource } from "@/lib/context/sources/githubSource";
import type { RepositorySummary } from "@/lib/services/github";
import type { RetrievalQuery } from "@/lib/context/types";

/** Build a valid production RepositorySummary fixture. */
function makeRepo(overrides: Partial<RepositorySummary> = {}): RepositorySummary {
  return {
    id: 1001,
    name: "briefly",
    fullName: "divyansh/briefly",
    owner: "divyansh",
    ownerAvatarUrl: "https://avatars.example/divyansh.png",
    description: "AI-powered meeting summarizer.",
    htmlUrl: "https://github.com/divyansh/briefly",
    apiUrl: "https://api.github.com/repos/divyansh/briefly",
    isPrivate: false,
    isFork: false,
    language: "TypeScript",
    starCount: 42,
    watchersCount: 3,
    openIssuesCount: 7,
    defaultBranch: "main",
    updatedAt: "2026-08-01T10:00:00Z",
    ...overrides,
  };
}

/** Mock production GitHubService with spy-able methods. */
interface MockProductionService extends ProductionGitHubService {
  createClientForUser: ReturnType<typeof vi.fn>;
  listRepositories: ReturnType<typeof vi.fn>;
  searchRepositories: ReturnType<typeof vi.fn>;
}

function makeService(
  overrides: {
    repositories?: RepositorySummary[];
    availabilityError?: unknown;
    searchError?: unknown;
    listError?: unknown;
  } = {},
): MockProductionService {
  const noPagination = { next: null, prev: null, first: null, last: null, hasNext: false };
  const service = {
    createClientForUser: vi.fn(async () => {
      if (overrides.availabilityError !== undefined) throw overrides.availabilityError;
      return { client: {}, integration: { id: "int-1" } };
    }),
    listRepositories: vi.fn(async () => {
      if (overrides.listError !== undefined) throw overrides.listError;
      return { repositories: overrides.repositories ?? [], pagination: noPagination };
    }),
    searchRepositories: vi.fn(async () => {
      if (overrides.searchError !== undefined) throw overrides.searchError;
      return {
        repositories: overrides.repositories ?? [],
        totalCount: (overrides.repositories ?? []).length,
        pagination: noPagination,
      };
    }),
  };
  return service as unknown as MockProductionService;
}

describe("GitHubServiceAdapter construction", () => {
  it("constructs with an injected mock production service", () => {
    const adapter = new GitHubServiceAdapter(makeService());
    expect(adapter).toBeInstanceOf(GitHubServiceAdapter);
  });

  it("constructs with the default production service (no arguments)", () => {
    const adapter = new GitHubServiceAdapter();
    expect(adapter).toBeInstanceOf(GitHubServiceAdapter);
  });

  it("stores the injected service and delegates to it", async () => {
    const service = makeService({ repositories: [makeRepo()] });
    const adapter = new GitHubServiceAdapter(service);
    const items = await adapter.retrieveRelevantItems({
      userId: "user-1",
      query: "briefly",
      maxItems: 5,
    });
    expect(service.searchRepositories).toHaveBeenCalled();
    expect(items).toHaveLength(1);
  });
});

describe("GitHubServiceAdapter isAvailable", () => {
  it("returns true when createClientForUser resolves", async () => {
    const adapter = new GitHubServiceAdapter(makeService());
    await expect(adapter.isAvailable("user-1")).resolves.toBe(true);
  });

  it("returns false when createClientForUser rejects", async () => {
    const adapter = new GitHubServiceAdapter(
      makeService({ availabilityError: new Error("github_not_connected") }),
    );
    await expect(adapter.isAvailable("user-1")).resolves.toBe(false);
  });

  it("delegates to createClientForUser (no extra logic)", async () => {
    const service = makeService();
    const adapter = new GitHubServiceAdapter(service);
    await adapter.isAvailable("user-1");
    expect(service.createClientForUser).toHaveBeenCalledTimes(1);
    expect(service.createClientForUser).toHaveBeenCalledWith();
  });

  it("accepts a userId argument without error", async () => {
    const adapter = new GitHubServiceAdapter(makeService());
    await expect(adapter.isAvailable("any-user-id")).resolves.toBe(true);
  });

  it("does not retry on failure (createClientForUser called exactly once)", async () => {
    const service = makeService({ availabilityError: new Error("down") });
    const adapter = new GitHubServiceAdapter(service);
    await adapter.isAvailable("user-1");
    expect(service.createClientForUser).toHaveBeenCalledTimes(1);
  });

  it("does not cache: each call delegates again", async () => {
    const service = makeService();
    const adapter = new GitHubServiceAdapter(service);
    await adapter.isAvailable("user-1");
    await adapter.isAvailable("user-1");
    expect(service.createClientForUser).toHaveBeenCalledTimes(2);
  });

  it("always resolves to a boolean (never rejects)", async () => {
    const service = makeService({ availabilityError: new Error("boom") });
    const adapter = new GitHubServiceAdapter(service);
    await expect(adapter.isAvailable("user-1")).resolves.toBe(false);
  });
});

describe("GitHubServiceAdapter retrieveRelevantItems delegation", () => {
  it("delegates a non-empty query to searchRepositories with { query, perPage }", async () => {
    const service = makeService({ repositories: [makeRepo()] });
    const adapter = new GitHubServiceAdapter(service);
    await adapter.retrieveRelevantItems({ userId: "u", query: "briefly", maxItems: 5 });
    // production signature: searchRepositories({ query, sort?, order?, page?, perPage? })
    expect(service.searchRepositories).toHaveBeenCalledWith({ query: "briefly", perPage: 5 });
    expect(service.listRepositories).not.toHaveBeenCalled();
  });

  it("delegates an empty query to listRepositories with { perPage }", async () => {
    const service = makeService({ repositories: [makeRepo()] });
    const adapter = new GitHubServiceAdapter(service);
    await adapter.retrieveRelevantItems({ userId: "u", query: "", maxItems: 5 });
    expect(service.listRepositories).toHaveBeenCalledWith({ perPage: 5 });
    expect(service.searchRepositories).not.toHaveBeenCalled();
  });

  it("delegates a blank/whitespace-only query to listRepositories", async () => {
    const service = makeService();
    const adapter = new GitHubServiceAdapter(service);
    await adapter.retrieveRelevantItems({ userId: "u", query: "   ", maxItems: 3 });
    expect(service.listRepositories).toHaveBeenCalledWith({ perPage: 3 });
    expect(service.searchRepositories).not.toHaveBeenCalled();
  });

  it("forwards a missing maxItems as undefined to searchRepositories", async () => {
    const service = makeService();
    const adapter = new GitHubServiceAdapter(service);
    await adapter.retrieveRelevantItems({ userId: "u", query: "briefly" });
    expect(service.searchRepositories).toHaveBeenCalledWith({ query: "briefly", perPage: undefined });
  });

  it("forwards a missing maxItems as undefined to listRepositories", async () => {
    const service = makeService();
    const adapter = new GitHubServiceAdapter(service);
    await adapter.retrieveRelevantItems({ userId: "u", query: "" });
    expect(service.listRepositories).toHaveBeenCalledWith({ perPage: undefined });
  });

  it("passes a padded query verbatim to searchRepositories (no trimming)", async () => {
    const service = makeService();
    const adapter = new GitHubServiceAdapter(service);
    await adapter.retrieveRelevantItems({ userId: "u", query: "  briefly  ", maxItems: 2 });
    expect(service.searchRepositories).toHaveBeenCalledWith({ query: "  briefly  ", perPage: 2 });
  });

  it("accepts a history option without error", async () => {
    const service = makeService();
    const adapter = new GitHubServiceAdapter(service);
    await expect(
      adapter.retrieveRelevantItems({
        userId: "u",
        query: "briefly",
        history: ["User: hi", "Assistant: hello"],
        maxItems: 5,
      }),
    ).resolves.toEqual([]);
  });

  it("preserves the production ordering without filtering or reranking", async () => {
    const repositories = [makeRepo({ id: 1 }), makeRepo({ id: 2 }), makeRepo({ id: 3 })];
    const adapter = new GitHubServiceAdapter(makeService({ repositories }));
    const result = await adapter.retrieveRelevantItems({ userId: "u", query: "q", maxItems: 10 });
    expect(result.map((item) => item.id)).toEqual(["1", "2", "3"]);
  });
});

describe("GitHubServiceAdapter mapping", () => {
  it("maps every compatible field", async () => {
    const repo = makeRepo();
    const adapter = new GitHubServiceAdapter(makeService({ repositories: [repo] }));
    const [mapped] = await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(mapped).toEqual({
      id: "1001",
      title: "briefly",
      content: "AI-powered meeting summarizer.",
      timestamp: "2026-08-01T10:00:00Z",
      repository: "divyansh/briefly",
      author: "divyansh",
    });
  });

  it("maps the production id (stringified)", async () => {
    const adapter = new GitHubServiceAdapter(makeService({ repositories: [makeRepo({ id: 42 })] }));
    const [mapped] = await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(mapped.id).toBe("42");
  });

  it("maps the production name to title", async () => {
    const adapter = new GitHubServiceAdapter(
      makeService({ repositories: [makeRepo({ name: "context-engine" })] }),
    );
    const [mapped] = await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(mapped.title).toBe("context-engine");
  });

  it("maps the production description to content", async () => {
    const adapter = new GitHubServiceAdapter(
      makeService({ repositories: [makeRepo({ description: "Context retrieval for the LLM." })] }),
    );
    const [mapped] = await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(mapped.content).toBe("Context retrieval for the LLM.");
  });

  it("maps the production updatedAt to timestamp", async () => {
    const adapter = new GitHubServiceAdapter(
      makeService({ repositories: [makeRepo({ updatedAt: "2026-07-20T08:15:00Z" })] }),
    );
    const [mapped] = await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(mapped.timestamp).toBe("2026-07-20T08:15:00Z");
  });

  it("maps the production fullName to repository", async () => {
    const adapter = new GitHubServiceAdapter(
      makeService({ repositories: [makeRepo({ fullName: "acme/context-engine" })] }),
    );
    const [mapped] = await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(mapped.repository).toBe("acme/context-engine");
  });

  it("leaves issueNumber undefined (production exposes no issue numbers)", async () => {
    const adapter = new GitHubServiceAdapter(makeService({ repositories: [makeRepo()] }));
    const [mapped] = await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(mapped.issueNumber).toBeUndefined();
  });

  it("leaves pullRequestNumber undefined (production exposes no PR numbers)", async () => {
    const adapter = new GitHubServiceAdapter(makeService({ repositories: [makeRepo()] }));
    const [mapped] = await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(mapped.pullRequestNumber).toBeUndefined();
  });

  it("maps the production owner to author", async () => {
    const adapter = new GitHubServiceAdapter(
      makeService({ repositories: [makeRepo({ owner: "alice" })] }),
    );
    const [mapped] = await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(mapped.author).toBe("alice");
  });

  it("never invents a relevance score (omitted)", async () => {
    const adapter = new GitHubServiceAdapter(makeService({ repositories: [makeRepo()] }));
    const [mapped] = await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(mapped.relevance).toBeUndefined();
  });

  it("never invents an importance level (omitted)", async () => {
    const adapter = new GitHubServiceAdapter(makeService({ repositories: [makeRepo()] }));
    const [mapped] = await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(mapped.importance).toBeUndefined();
  });

  it("normalizes a null title to an empty string", async () => {
    const adapter = new GitHubServiceAdapter(
      makeService({ repositories: [makeRepo({ name: null as unknown as string })] }),
    );
    const [mapped] = await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(mapped.title).toBe("");
  });

  it("normalizes a null content to an empty string", async () => {
    const adapter = new GitHubServiceAdapter(
      makeService({ repositories: [makeRepo({ description: null })] }),
    );
    const [mapped] = await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(mapped.content).toBe("");
  });

  it("maps a null timestamp to undefined", async () => {
    const adapter = new GitHubServiceAdapter(
      makeService({ repositories: [makeRepo({ updatedAt: null })] }),
    );
    const [mapped] = await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(mapped.timestamp).toBeUndefined();
  });

  it("omits missing optional metadata (author, timestamp, repository)", async () => {
    const adapter = new GitHubServiceAdapter(
      makeService({
        repositories: [makeRepo({ owner: null, updatedAt: null, fullName: "" })],
      }),
    );
    const [mapped] = await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(mapped.author).toBeUndefined();
    expect(mapped.timestamp).toBeUndefined();
    expect(mapped.repository).toBeUndefined();
  });
});

describe("GitHubServiceAdapter responses", () => {
  it("returns an empty list for an empty production response", async () => {
    const adapter = new GitHubServiceAdapter(makeService({ repositories: [] }));
    await expect(
      adapter.retrieveRelevantItems({ userId: "u", query: "q" }),
    ).resolves.toEqual([]);
  });

  it("maps multiple repositories preserving order", async () => {
    const repositories = [makeRepo({ id: 1 }), makeRepo({ id: 2 }), makeRepo({ id: 3 })];
    const adapter = new GitHubServiceAdapter(makeService({ repositories }));
    const result = await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(result.map((item) => item.id)).toEqual(["1", "2", "3"]);
  });

  it("handles a large production response", async () => {
    const repositories = Array.from({ length: 1000 }, (_, i) => makeRepo({ id: i }));
    const adapter = new GitHubServiceAdapter(makeService({ repositories }));
    const result = await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(result).toHaveLength(1000);
    expect(result[999].id).toBe("999");
  });

  it("is deterministic across repeated calls", async () => {
    const repositories = [makeRepo({ id: 1 }), makeRepo({ id: 2 })];
    const adapter = new GitHubServiceAdapter(makeService({ repositories }));
    const options = { userId: "u", query: "q" };
    const first = await adapter.retrieveRelevantItems(options);
    const second = await adapter.retrieveRelevantItems(options);
    expect(second).toEqual(first);
  });
});

describe("GitHubServiceAdapter error propagation", () => {
  it("forwards an async searchRepositories rejection (never swallowed)", async () => {
    const error = new Error("github search down");
    const adapter = new GitHubServiceAdapter(makeService({ searchError: error }));
    await expect(
      adapter.retrieveRelevantItems({ userId: "u", query: "q" }),
    ).rejects.toBe(error);
  });

  it("forwards an async listRepositories rejection (never swallowed)", async () => {
    const error = new Error("github list down");
    const adapter = new GitHubServiceAdapter(makeService({ listError: error }));
    await expect(
      adapter.retrieveRelevantItems({ userId: "u", query: "" }),
    ).rejects.toBe(error);
  });

  it("forwards a synchronous searchRepositories throw", async () => {
    const error = new Error("sync boom");
    const service = makeService();
    service.searchRepositories.mockImplementation(() => {
      throw error;
    });
    const adapter = new GitHubServiceAdapter(service);
    await expect(
      adapter.retrieveRelevantItems({ userId: "u", query: "q" }),
    ).rejects.toBe(error);
  });

  it("forwards a synchronous listRepositories throw", async () => {
    const error = new Error("sync list boom");
    const service = makeService();
    service.listRepositories.mockImplementation(() => {
      throw error;
    });
    const adapter = new GitHubServiceAdapter(service);
    await expect(
      adapter.retrieveRelevantItems({ userId: "u", query: "" }),
    ).rejects.toBe(error);
  });
});

describe("GitHubServiceAdapter retry behavior", () => {
  it("calls searchRepositories exactly once on success", async () => {
    const service = makeService({ repositories: [makeRepo()] });
    const adapter = new GitHubServiceAdapter(service);
    await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(service.searchRepositories).toHaveBeenCalledTimes(1);
  });

  it("calls listRepositories exactly once on success", async () => {
    const service = makeService({ repositories: [makeRepo()] });
    const adapter = new GitHubServiceAdapter(service);
    await adapter.retrieveRelevantItems({ userId: "u", query: "" });
    expect(service.listRepositories).toHaveBeenCalledTimes(1);
  });

  it("never retries a failing search (single delegation)", async () => {
    const service = makeService({ searchError: new Error("down") });
    const adapter = new GitHubServiceAdapter(service);
    await adapter.retrieveRelevantItems({ userId: "u", query: "q" }).catch(() => undefined);
    expect(service.searchRepositories).toHaveBeenCalledTimes(1);
  });
});

describe("GitHubServiceAdapter immutability", () => {
  it("does not mutate the options object passed to retrieveRelevantItems", async () => {
    const service = makeService({ repositories: [makeRepo()] });
    const adapter = new GitHubServiceAdapter(service);
    const options = { userId: "u", query: "briefly", history: ["hi"], maxItems: 5 };
    const snapshot = { ...options };
    await adapter.retrieveRelevantItems(options);
    expect(options).toEqual(snapshot);
  });

  it("does not mutate the production repositories array", async () => {
    const repositories = [makeRepo({ id: 1 }), makeRepo({ id: 2 })];
    const snapshot = JSON.parse(JSON.stringify(repositories)) as RepositorySummary[];
    const adapter = new GitHubServiceAdapter(makeService({ repositories }));
    await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(repositories).toEqual(snapshot);
  });

  it("returns new item objects (not the production summary references)", async () => {
    const repo = makeRepo();
    const adapter = new GitHubServiceAdapter(makeService({ repositories: [repo] }));
    const [mapped] = await adapter.retrieveRelevantItems({ userId: "u", query: "q" });
    expect(mapped).not.toBe(repo);
  });
});

describe("GitHubServiceAdapter GitHubSource integration", () => {
  it("satisfies the GitHubSource contract end-to-end", async () => {
    const service = makeService({
      repositories: [makeRepo({ id: 7, name: "briefly", description: "AI summarizer" })],
    });
    const adapter = new GitHubServiceAdapter(service);
    const source = new GitHubSource(adapter);
    const query: RetrievalQuery = { userId: "user-1", query: "briefly" };
    const contexts = await source.retrieve(query);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      id: "7",
      source: "github",
      title: "briefly",
      content: "AI summarizer",
    });
    expect(service.searchRepositories).toHaveBeenCalledWith({
      query: "briefly",
      perPage: undefined,
    });
  });

  it("drives GitHubSource isAvailable through the adapter", async () => {
    const adapter = new GitHubServiceAdapter(makeService());
    const source = new GitHubSource(adapter);
    await expect(source.isAvailable("user-1")).resolves.toBe(true);
  });

  it("reports unavailability through GitHubSource when the service rejects", async () => {
    const adapter = new GitHubServiceAdapter(
      makeService({ availabilityError: new Error("not connected") }),
    );
    const source = new GitHubSource(adapter);
    await expect(source.isAvailable("user-1")).resolves.toBe(false);
  });

  it("defaults relevance to 0.5 downstream when the adapter omits it", async () => {
    const adapter = new GitHubServiceAdapter(makeService({ repositories: [makeRepo()] }));
    const source = new GitHubSource(adapter);
    const contexts = await source.retrieve({ userId: "u", query: "q" });
    expect(contexts[0].relevance).toBe(0.5);
  });
});
