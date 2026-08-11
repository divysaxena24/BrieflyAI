import { describe, it, expect, vi } from "vitest";
import { MemorySource } from "@/lib/context/sources/memorySource";
import { ContextSourceBase } from "@/lib/context/sources/contextSource";
import { estimateTokens } from "@/lib/context/tokenBudget";
import type { MemoryItem, MemoryService } from "@/lib/context/sources/memorySource";
import type { RetrievalQuery } from "@/lib/context/types";

/** Build a valid MemoryItem fixture. */
function makeMemory(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: "mem-1",
    title: "Likes coffee",
    content: "User prefers coffee over tea.",
    timestamp: "2026-08-01T09:00:00Z",
    relevance: 0.9,
    importance: "high",
    ...overrides,
  };
}

/** Build a valid RetrievalQuery fixture. */
function makeQuery(overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    userId: "user-1",
    query: "what do I like to drink?",
    history: ["User: hi", "Assistant: hello"],
    maxItems: 5,
    ...overrides,
  };
}

interface MockService extends MemoryService {
  isAvailable: ReturnType<typeof vi.fn>;
  retrieveRelevantMemory: ReturnType<typeof vi.fn>;
}

/** Build a fully mocked MemoryService. */
function makeService(
  overrides: { available?: boolean; memories?: MemoryItem[]; error?: unknown } = {},
): MockService {
  const service = {
    isAvailable: vi.fn(async (): Promise<boolean> => {
      if (overrides.error !== undefined) throw overrides.error;
      return overrides.available ?? true;
    }),
    retrieveRelevantMemory: vi.fn(async (): Promise<MemoryItem[]> => {
      if (overrides.error !== undefined) throw overrides.error;
      return overrides.memories ?? [];
    }),
  };
  return service as unknown as MockService;
}

describe("MemorySource identity", () => {
  it("exposes the id 'memory'", () => {
    expect(new MemorySource(makeService()).id).toBe("memory");
  });

  it("exposes priority 100", () => {
    expect(new MemorySource(makeService()).priority).toBe(100);
  });

  it("extends ContextSourceBase", () => {
    expect(new MemorySource(makeService())).toBeInstanceOf(ContextSourceBase);
  });

  it("stores the injected service for later calls", async () => {
    const service = makeService({ memories: [makeMemory()] });
    const source = new MemorySource(service);
    const contexts = await source.retrieve(makeQuery());
    expect(service.retrieveRelevantMemory).toHaveBeenCalled();
    expect(contexts).toHaveLength(1);
  });
});

describe("MemorySource isAvailable", () => {
  it("forwards to the memory service", async () => {
    const service = makeService({ available: true });
    const source = new MemorySource(service);
    await expect(source.isAvailable("user-1")).resolves.toBe(true);
    expect(service.isAvailable).toHaveBeenCalledWith("user-1");
  });

  it("returns false when the service reports unavailable", async () => {
    const source = new MemorySource(makeService({ available: false }));
    await expect(source.isAvailable("user-9")).resolves.toBe(false);
  });

  it("passes the exact userId through", async () => {
    const service = makeService();
    const source = new MemorySource(service);
    await source.isAvailable("some-user-id");
    expect(service.isAvailable).toHaveBeenCalledWith("some-user-id");
  });

  it("propagates a service rejection (no extra logic in isAvailable)", async () => {
    const error = new Error("memory service down");
    const source = new MemorySource(makeService({ error }));
    await expect(source.isAvailable("user-1")).rejects.toBe(error);
  });
});

describe("MemorySource retrieve service call", () => {
  it("calls retrieveRelevantMemory with the query fields", async () => {
    const service = makeService();
    const source = new MemorySource(service);
    const query = makeQuery();
    await source.retrieve(query);
    expect(service.retrieveRelevantMemory).toHaveBeenCalledWith({
      userId: "user-1",
      query: "what do I like to drink?",
      history: ["User: hi", "Assistant: hello"],
      maxItems: 5,
    });
  });

  it("forwards missing optional fields as undefined", async () => {
    const service = makeService();
    const source = new MemorySource(service);
    await source.retrieve(makeQuery({ history: undefined, maxItems: undefined }));
    expect(service.retrieveRelevantMemory).toHaveBeenCalledWith({
      userId: "user-1",
      query: "what do I like to drink?",
      history: undefined,
      maxItems: undefined,
    });
  });
});

describe("MemorySource Context mapping", () => {
  it("maps every field of a memory to a Context", async () => {
    const memory = makeMemory();
    const source = new MemorySource(makeService({ memories: [memory] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context).toMatchObject({
      id: "mem-1",
      source: "memory",
      title: "Likes coffee",
      content: "User prefers coffee over tea.",
      timestamp: "2026-08-01T09:00:00Z",
      relevance: 0.9,
      truncated: false,
      compressed: false,
      permissions: null,
    });
  });

  it("sets source to 'memory'", async () => {
    const source = new MemorySource(makeService({ memories: [makeMemory()] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.source).toBe("memory");
  });

  it("computes tokenEstimate with estimateTokens(content)", async () => {
    const memory = makeMemory({ content: "prefers coffee" });
    const source = new MemorySource(makeService({ memories: [memory] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.tokenEstimate).toBe(estimateTokens("prefers coffee"));
    expect(context.tokenEstimate).toBe(Math.ceil("prefers coffee".length / 4));
  });

  it("estimates tokens for empty content as 0", async () => {
    const source = new MemorySource(makeService({ memories: [makeMemory({ content: "" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.tokenEstimate).toBe(0);
  });

  it("maps a null timestamp to null", async () => {
    const source = new MemorySource(makeService({ memories: [makeMemory({ timestamp: null })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.timestamp).toBeNull();
  });

  it("maps a missing timestamp (undefined) to null", async () => {
    const source = new MemorySource(makeService({ memories: [makeMemory({ timestamp: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.timestamp).toBeNull();
  });

  it("keeps a provided timestamp verbatim", async () => {
    const source = new MemorySource(
      makeService({ memories: [makeMemory({ timestamp: "2026-08-02T10:00:00Z" })] }),
    );
    const [context] = await source.retrieve(makeQuery());
    expect(context.timestamp).toBe("2026-08-02T10:00:00Z");
  });

  it("defaults relevance to 0.5 when missing", async () => {
    const source = new MemorySource(makeService({ memories: [makeMemory({ relevance: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.relevance).toBe(0.5);
  });

  it("keeps an explicit relevance score", async () => {
    const source = new MemorySource(makeService({ memories: [makeMemory({ relevance: 0.3 })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.relevance).toBe(0.3);
  });

  it("sets metadata.kind to 'memory' and entityId to the memory id", async () => {
    const source = new MemorySource(makeService({ memories: [makeMemory({ id: "mem-42" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.kind).toBe("memory");
    expect(context.metadata.entityId).toBe("mem-42");
  });

  it("maps metadata.importance from the memory", async () => {
    const source = new MemorySource(makeService({ memories: [makeMemory({ importance: "critical" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.importance).toBe("critical");
  });

  it("omits importance when the memory has none", async () => {
    const source = new MemorySource(makeService({ memories: [makeMemory({ importance: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.importance).toBeUndefined();
  });

  it("stores the original memory object in metadata.raw", async () => {
    const memory = makeMemory({ content: "unique raw payload", importance: "low" });
    const source = new MemorySource(makeService({ memories: [memory] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.raw).toBe(memory);
  });

  it("sets permissions to null", async () => {
    const source = new MemorySource(makeService({ memories: [makeMemory()] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.permissions).toBeNull();
  });

  it("marks the context as neither truncated nor compressed", async () => {
    const source = new MemorySource(makeService({ memories: [makeMemory()] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.truncated).toBe(false);
    expect(context.compressed).toBe(false);
  });
});

describe("MemorySource error handling", () => {
  it("returns [] when the service rejects", async () => {
    const source = new MemorySource(makeService({ error: new Error("service boom") }));
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });

  it("returns [] when the service throws synchronously", async () => {
    const service = {
      isAvailable: vi.fn(async () => true),
      retrieveRelevantMemory: vi.fn((): Promise<MemoryItem[]> => {
        throw new Error("sync boom");
      }),
    } as unknown as MemoryService;
    const source = new MemorySource(service);
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });

  it("never throws for a failing service", async () => {
    const source = new MemorySource(makeService({ error: new Error("down") }));
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });
});

describe("MemorySource result behavior", () => {
  it("returns an empty array for an empty memory list", async () => {
    const source = new MemorySource(makeService({ memories: [] }));
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });

  it("maps multiple memories", async () => {
    const memories = [makeMemory({ id: "a" }), makeMemory({ id: "b" }), makeMemory({ id: "c" })];
    const source = new MemorySource(makeService({ memories }));
    const contexts = await source.retrieve(makeQuery());
    expect(contexts).toHaveLength(3);
    expect(contexts.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("preserves the service's ordering", async () => {
    const memories = [
      makeMemory({ id: "first", relevance: 0.9 }),
      makeMemory({ id: "second", relevance: 0.4 }),
      makeMemory({ id: "third", relevance: 0.1 }),
    ];
    const source = new MemorySource(makeService({ memories }));
    const contexts = await source.retrieve(makeQuery());
    expect(contexts.map((c) => c.id)).toEqual(["first", "second", "third"]);
  });

  it("is deterministic across repeated calls", async () => {
    const memories = [makeMemory({ id: "a" }), makeMemory({ id: "b" })];
    const source = new MemorySource(makeService({ memories }));
    const first = await source.retrieve(makeQuery());
    const second = await source.retrieve(makeQuery());
    expect(second).toEqual(first);
  });
});

describe("MemorySource immutability", () => {
  it("does not mutate the retrieval query", async () => {
    const query = makeQuery();
    const snapshot = JSON.parse(JSON.stringify(query)) as RetrievalQuery;
    const source = new MemorySource(makeService({ memories: [makeMemory()] }));
    await source.retrieve(query);
    expect(query).toEqual(snapshot);
  });

  it("does not mutate the memory objects", async () => {
    const memory = makeMemory({ content: "original" });
    const snapshot = JSON.parse(JSON.stringify(memory)) as MemoryItem;
    const source = new MemorySource(makeService({ memories: [memory] }));
    await source.retrieve(makeQuery());
    expect(memory).toEqual(snapshot);
  });

  it("returns new Context objects (not the memory references)", async () => {
    const memory = makeMemory();
    const source = new MemorySource(makeService({ memories: [memory] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context).not.toBe(memory);
    expect(context.metadata.raw).toBe(memory);
  });
});
