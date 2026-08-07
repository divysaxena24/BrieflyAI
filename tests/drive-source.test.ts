import { describe, it, expect, vi } from "vitest";
import { DriveSource } from "@/lib/context/sources/driveSource";
import { ContextSourceBase } from "@/lib/context/sources/contextSource";
import { estimateTokens } from "@/lib/context/tokenBudget";
import type { DriveFile, DriveService } from "@/lib/context/sources/driveSource";
import type { RetrievalQuery } from "@/lib/context/types";

/** Build a valid DriveFile fixture. */
function makeFile(overrides: Partial<DriveFile> = {}): DriveFile {
  return {
    id: "file-1",
    title: "Sprint Planning Notes",
    content: "Q3 roadmap and sprint goals for the team.",
    timestamp: "2026-08-05T08:00:00Z",
    relevance: 0.9,
    mimeType: "text/plain",
    path: "/Team/Planning",
    owner: "dana@example.com",
    importance: "high",
    ...overrides,
  };
}

/** Build a valid RetrievalQuery fixture. */
function makeQuery(overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    userId: "user-1",
    query: "sprint planning",
    history: ["User: hi", "Assistant: hello"],
    maxItems: 5,
    ...overrides,
  };
}

interface MockService extends DriveService {
  isAvailable: ReturnType<typeof vi.fn>;
  retrieveRelevantFiles: ReturnType<typeof vi.fn>;
}

/** Build a fully mocked DriveService. */
function makeService(
  overrides: { available?: boolean; files?: DriveFile[]; error?: unknown } = {},
): MockService {
  const service = {
    isAvailable: vi.fn(async (): Promise<boolean> => {
      if (overrides.error !== undefined) throw overrides.error;
      return overrides.available ?? true;
    }),
    retrieveRelevantFiles: vi.fn(async (): Promise<DriveFile[]> => {
      if (overrides.error !== undefined) throw overrides.error;
      return overrides.files ?? [];
    }),
  };
  return service as unknown as MockService;
}

describe("DriveSource identity", () => {
  it("exposes the id 'drive'", () => {
    expect(new DriveSource(makeService()).id).toBe("drive");
  });

  it("exposes priority 20", () => {
    expect(new DriveSource(makeService()).priority).toBe(20);
  });

  it("extends ContextSourceBase", () => {
    expect(new DriveSource(makeService())).toBeInstanceOf(ContextSourceBase);
  });

  it("stores the injected service for later calls", async () => {
    const service = makeService({ files: [makeFile()] });
    const source = new DriveSource(service);
    const contexts = await source.retrieve(makeQuery());
    expect(service.retrieveRelevantFiles).toHaveBeenCalled();
    expect(contexts).toHaveLength(1);
  });
});

describe("DriveSource isAvailable", () => {
  it("forwards true from the service", async () => {
    const service = makeService({ available: true });
    const source = new DriveSource(service);
    await expect(source.isAvailable("user-1")).resolves.toBe(true);
    expect(service.isAvailable).toHaveBeenCalledWith("user-1");
  });

  it("forwards false from the service", async () => {
    const source = new DriveSource(makeService({ available: false }));
    await expect(source.isAvailable("user-9")).resolves.toBe(false);
  });

  it("passes the exact userId through", async () => {
    const service = makeService();
    const source = new DriveSource(service);
    await source.isAvailable("some-user-id");
    expect(service.isAvailable).toHaveBeenCalledWith("some-user-id");
  });

  it("propagates a service rejection (no try/catch in isAvailable)", async () => {
    const error = new Error("drive service down");
    const source = new DriveSource(makeService({ error }));
    await expect(source.isAvailable("user-1")).rejects.toBe(error);
  });
});

describe("DriveSource retrieve service call", () => {
  it("forwards the exact arguments", async () => {
    const service = makeService();
    const source = new DriveSource(service);
    const query = makeQuery();
    await source.retrieve(query);
    expect(service.retrieveRelevantFiles).toHaveBeenCalledWith({
      userId: "user-1",
      query: "sprint planning",
      history: ["User: hi", "Assistant: hello"],
      maxItems: 5,
    });
  });

  it("forwards missing history as undefined", async () => {
    const service = makeService();
    const source = new DriveSource(service);
    await source.retrieve(makeQuery({ history: undefined }));
    expect(service.retrieveRelevantFiles).toHaveBeenCalledWith({
      userId: "user-1",
      query: "sprint planning",
      history: undefined,
      maxItems: 5,
    });
  });

  it("forwards missing maxItems as undefined", async () => {
    const service = makeService();
    const source = new DriveSource(service);
    await source.retrieve(makeQuery({ maxItems: undefined }));
    expect(service.retrieveRelevantFiles).toHaveBeenCalledWith({
      userId: "user-1",
      query: "sprint planning",
      history: ["User: hi", "Assistant: hello"],
      maxItems: undefined,
    });
  });

  it("returns an empty array for an empty file list", async () => {
    const source = new DriveSource(makeService({ files: [] }));
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });

  it("maps multiple files", async () => {
    const files = [makeFile({ id: "a" }), makeFile({ id: "b" }), makeFile({ id: "c" })];
    const source = new DriveSource(makeService({ files }));
    const contexts = await source.retrieve(makeQuery());
    expect(contexts).toHaveLength(3);
    expect(contexts.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("preserves the service's ordering", async () => {
    const files = [
      makeFile({ id: "first", relevance: 0.9 }),
      makeFile({ id: "second", relevance: 0.4 }),
      makeFile({ id: "third", relevance: 0.1 }),
    ];
    const source = new DriveSource(makeService({ files }));
    const contexts = await source.retrieve(makeQuery());
    expect(contexts.map((c) => c.id)).toEqual(["first", "second", "third"]);
  });

  it("is deterministic across repeated calls", async () => {
    const files = [makeFile({ id: "a" }), makeFile({ id: "b" })];
    const source = new DriveSource(makeService({ files }));
    const first = await source.retrieve(makeQuery());
    const second = await source.retrieve(makeQuery());
    expect(second).toEqual(first);
  });
});

describe("DriveSource Context mapping", () => {
  it("maps every field of a file to a Context", async () => {
    const file = makeFile();
    const source = new DriveSource(makeService({ files: [file] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context).toMatchObject({
      id: "file-1",
      source: "drive",
      title: "Sprint Planning Notes",
      content: "Q3 roadmap and sprint goals for the team.",
      timestamp: "2026-08-05T08:00:00Z",
      relevance: 0.9,
      truncated: false,
      compressed: false,
      permissions: null,
    });
  });

  it("maps the title", async () => {
    const source = new DriveSource(makeService({ files: [makeFile({ title: "Budget.xlsx" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.title).toBe("Budget.xlsx");
  });

  it("maps the content", async () => {
    const source = new DriveSource(makeService({ files: [makeFile({ content: "Body text" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.content).toBe("Body text");
  });

  it("sets source to 'drive'", async () => {
    const source = new DriveSource(makeService({ files: [makeFile()] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.source).toBe("drive");
  });

  it("computes tokenEstimate with estimateTokens(content)", async () => {
    const file = makeFile({ content: "short body" });
    const source = new DriveSource(makeService({ files: [file] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.tokenEstimate).toBe(estimateTokens("short body"));
    expect(context.tokenEstimate).toBe(Math.ceil("short body".length / 4));
  });

  it("maps a provided timestamp verbatim", async () => {
    const source = new DriveSource(
      makeService({ files: [makeFile({ timestamp: "2026-08-02T10:00:00Z" })] }),
    );
    const [context] = await source.retrieve(makeQuery());
    expect(context.timestamp).toBe("2026-08-02T10:00:00Z");
  });

  it("maps a missing timestamp (undefined) to null", async () => {
    const source = new DriveSource(makeService({ files: [makeFile({ timestamp: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.timestamp).toBeNull();
  });

  it("maps a null timestamp to null", async () => {
    const source = new DriveSource(makeService({ files: [makeFile({ timestamp: null })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.timestamp).toBeNull();
  });

  it("defaults relevance to 0.5 when missing", async () => {
    const source = new DriveSource(makeService({ files: [makeFile({ relevance: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.relevance).toBe(0.5);
  });

  it("keeps an explicit relevance score", async () => {
    const source = new DriveSource(makeService({ files: [makeFile({ relevance: 0.3 })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.relevance).toBe(0.3);
  });

  it("sets metadata.kind to 'drive'", async () => {
    const source = new DriveSource(makeService({ files: [makeFile()] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.kind).toBe("drive");
  });

  it("sets metadata.entityId to the file id", async () => {
    const source = new DriveSource(makeService({ files: [makeFile({ id: "file-42" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.entityId).toBe("file-42");
  });

  it("maps metadata.mimeType", async () => {
    const source = new DriveSource(makeService({ files: [makeFile({ mimeType: "application/pdf" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.mimeType).toBe("application/pdf");
  });

  it("leaves metadata.mimeType undefined when absent", async () => {
    const source = new DriveSource(makeService({ files: [makeFile({ mimeType: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.mimeType).toBeUndefined();
  });

  it("maps metadata.path", async () => {
    const source = new DriveSource(makeService({ files: [makeFile({ path: "/Team/Planning" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.path).toBe("/Team/Planning");
  });

  it("leaves metadata.path undefined when absent", async () => {
    const source = new DriveSource(makeService({ files: [makeFile({ path: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.path).toBeUndefined();
  });

  it("maps metadata.author from the owner", async () => {
    const source = new DriveSource(makeService({ files: [makeFile({ owner: "bob@x.com" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.author).toBe("bob@x.com");
  });

  it("maps metadata.importance", async () => {
    const source = new DriveSource(makeService({ files: [makeFile({ importance: "critical" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.importance).toBe("critical");
  });

  it("omits importance when the file has none", async () => {
    const source = new DriveSource(makeService({ files: [makeFile({ importance: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.importance).toBeUndefined();
  });

  it("stores the original file object in metadata.raw by reference", async () => {
    const file = makeFile({ content: "unique raw payload" });
    const source = new DriveSource(makeService({ files: [file] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.raw).toBe(file);
  });

  it("sets permissions to null", async () => {
    const source = new DriveSource(makeService({ files: [makeFile()] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.permissions).toBeNull();
  });

  it("marks the context as neither truncated nor compressed", async () => {
    const source = new DriveSource(makeService({ files: [makeFile()] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.truncated).toBe(false);
    expect(context.compressed).toBe(false);
  });
});

describe("DriveSource error handling", () => {
  it("returns [] when the service rejects asynchronously", async () => {
    const source = new DriveSource(makeService({ error: new Error("service boom") }));
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });

  it("returns [] when the service throws synchronously", async () => {
    const service = {
      isAvailable: vi.fn(async () => true),
      retrieveRelevantFiles: vi.fn((): Promise<DriveFile[]> => {
        throw new Error("sync boom");
      }),
    } as unknown as DriveService;
    const source = new DriveSource(service);
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });

  it("never throws for a failing service", async () => {
    const source = new DriveSource(makeService({ error: new Error("down") }));
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });
});

describe("DriveSource immutability", () => {
  it("does not mutate the retrieval query", async () => {
    const query = makeQuery();
    const snapshot = JSON.parse(JSON.stringify(query)) as RetrievalQuery;
    const source = new DriveSource(makeService({ files: [makeFile()] }));
    await source.retrieve(query);
    expect(query).toEqual(snapshot);
  });

  it("does not mutate the source file objects", async () => {
    const file = makeFile({ content: "original" });
    const snapshot = JSON.parse(JSON.stringify(file)) as DriveFile;
    const source = new DriveSource(makeService({ files: [file] }));
    await source.retrieve(makeQuery());
    expect(file).toEqual(snapshot);
  });

  it("returns new Context objects (not the file references)", async () => {
    const file = makeFile();
    const source = new DriveSource(makeService({ files: [file] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context).not.toBe(file);
  });

  it("preserves the raw reference to the original file", async () => {
    const file = makeFile();
    const source = new DriveSource(makeService({ files: [file] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.raw).toBe(file);
  });
});
