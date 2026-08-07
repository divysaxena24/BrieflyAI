import { describe, it, expect, vi } from "vitest";
import {
  DriveServiceAdapter,
  type ProductionDriveService,
} from "@/lib/context/adapters/driveServiceAdapter";
import { DriveSource } from "@/lib/context/sources/driveSource";
import type { DriveFile as ProductionDriveFile } from "@/lib/services/drive/types";
import type { RetrievalQuery } from "@/lib/context/types";

/** Build a valid production DriveFile fixture. */
function makeFile(overrides: Partial<ProductionDriveFile> = {}): ProductionDriveFile {
  return {
    id: "file-1",
    name: "Q3 Report.pdf",
    mimeType: "application/pdf",
    modifiedTime: "2026-08-05T10:00:00Z",
    parents: ["folder-a", "folder-b"],
    owners: [{ displayName: "Alice Chen", emailAddress: "alice@example.com" }],
    isFolder: false,
    ...overrides,
  };
}

/** Mock production DriveService with spy-able methods. */
interface MockProductionService extends ProductionDriveService {
  createClientForUser: ReturnType<typeof vi.fn>;
  listFiles: ReturnType<typeof vi.fn>;
  searchFiles: ReturnType<typeof vi.fn>;
}

function makeService(
  overrides: {
    files?: ProductionDriveFile[];
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
    listFiles: vi.fn(async () => {
      if (overrides.listError !== undefined) throw overrides.listError;
      return { files: overrides.files ?? [], nextPageToken: null };
    }),
    searchFiles: vi.fn(async () => {
      if (overrides.searchError !== undefined) throw overrides.searchError;
      return { files: overrides.files ?? [], nextPageToken: null };
    }),
  };
  return service as unknown as MockProductionService;
}

describe("DriveServiceAdapter construction", () => {
  it("constructs with an injected mock production service", () => {
    const adapter = new DriveServiceAdapter(makeService());
    expect(adapter).toBeInstanceOf(DriveServiceAdapter);
  });

  it("constructs with the default production service (no arguments)", () => {
    const adapter = new DriveServiceAdapter();
    expect(adapter).toBeInstanceOf(DriveServiceAdapter);
  });

  it("stores the injected service and delegates to it", async () => {
    const service = makeService({ files: [makeFile()] });
    const adapter = new DriveServiceAdapter(service);
    const files = await adapter.retrieveRelevantFiles({
      userId: "user-1",
      query: "report",
      maxItems: 5,
    });
    expect(service.searchFiles).toHaveBeenCalled();
    expect(files).toHaveLength(1);
  });
});

describe("DriveServiceAdapter isAvailable", () => {
  it("returns true when createClientForUser resolves", async () => {
    const adapter = new DriveServiceAdapter(makeService());
    await expect(adapter.isAvailable("user-1")).resolves.toBe(true);
  });

  it("returns false when createClientForUser rejects", async () => {
    const adapter = new DriveServiceAdapter(
      makeService({ availabilityError: new Error("google_not_connected") }),
    );
    await expect(adapter.isAvailable("user-1")).resolves.toBe(false);
  });

  it("delegates to createClientForUser (no extra logic)", async () => {
    const service = makeService();
    const adapter = new DriveServiceAdapter(service);
    await adapter.isAvailable("user-1");
    expect(service.createClientForUser).toHaveBeenCalledTimes(1);
    expect(service.createClientForUser).toHaveBeenCalledWith();
  });

  it("accepts a userId argument without error", async () => {
    const adapter = new DriveServiceAdapter(makeService());
    await expect(adapter.isAvailable("any-user-id")).resolves.toBe(true);
  });

  it("does not retry on failure (createClientForUser called exactly once)", async () => {
    const service = makeService({ availabilityError: new Error("down") });
    const adapter = new DriveServiceAdapter(service);
    await adapter.isAvailable("user-1");
    expect(service.createClientForUser).toHaveBeenCalledTimes(1);
  });

  it("does not cache: each call delegates again", async () => {
    const service = makeService();
    const adapter = new DriveServiceAdapter(service);
    await adapter.isAvailable("user-1");
    await adapter.isAvailable("user-1");
    expect(service.createClientForUser).toHaveBeenCalledTimes(2);
  });

  it("always resolves to a boolean (never rejects)", async () => {
    const service = makeService({ availabilityError: new Error("boom") });
    const adapter = new DriveServiceAdapter(service);
    await expect(adapter.isAvailable("user-1")).resolves.toBe(false);
  });
});

describe("DriveServiceAdapter retrieveRelevantFiles delegation", () => {
  it("delegates a non-empty query to searchFiles with (query, maxItems)", async () => {
    const service = makeService({ files: [makeFile()] });
    const adapter = new DriveServiceAdapter(service);
    await adapter.retrieveRelevantFiles({ userId: "u", query: "report", maxItems: 5 });
    // production signature: searchFiles(q, pageSize?, pageToken?)
    expect(service.searchFiles).toHaveBeenCalledWith("report", 5);
    expect(service.listFiles).not.toHaveBeenCalled();
  });

  it("delegates an empty query to listFiles with { pageSize }", async () => {
    const service = makeService({ files: [makeFile()] });
    const adapter = new DriveServiceAdapter(service);
    await adapter.retrieveRelevantFiles({ userId: "u", query: "", maxItems: 5 });
    expect(service.listFiles).toHaveBeenCalledWith({ pageSize: 5 });
    expect(service.searchFiles).not.toHaveBeenCalled();
  });

  it("delegates a blank/whitespace-only query to listFiles", async () => {
    const service = makeService();
    const adapter = new DriveServiceAdapter(service);
    await adapter.retrieveRelevantFiles({ userId: "u", query: "   ", maxItems: 3 });
    expect(service.listFiles).toHaveBeenCalledWith({ pageSize: 3 });
    expect(service.searchFiles).not.toHaveBeenCalled();
  });

  it("forwards a missing maxItems as undefined to searchFiles", async () => {
    const service = makeService();
    const adapter = new DriveServiceAdapter(service);
    await adapter.retrieveRelevantFiles({ userId: "u", query: "report" });
    expect(service.searchFiles).toHaveBeenCalledWith("report", undefined);
  });

  it("forwards a missing maxItems as undefined to listFiles", async () => {
    const service = makeService();
    const adapter = new DriveServiceAdapter(service);
    await adapter.retrieveRelevantFiles({ userId: "u", query: "" });
    expect(service.listFiles).toHaveBeenCalledWith({ pageSize: undefined });
  });

  it("passes a padded query verbatim to searchFiles (no trimming)", async () => {
    const service = makeService();
    const adapter = new DriveServiceAdapter(service);
    await adapter.retrieveRelevantFiles({ userId: "u", query: "  report  ", maxItems: 2 });
    expect(service.searchFiles).toHaveBeenCalledWith("  report  ", 2);
  });

  it("accepts a history option without error", async () => {
    const service = makeService();
    const adapter = new DriveServiceAdapter(service);
    await expect(
      adapter.retrieveRelevantFiles({
        userId: "u",
        query: "report",
        history: ["User: hi", "Assistant: hello"],
        maxItems: 5,
      }),
    ).resolves.toEqual([]);
  });

  it("preserves the production ordering without filtering or reranking", async () => {
    const files = [makeFile({ id: "a" }), makeFile({ id: "b" }), makeFile({ id: "c" })];
    const adapter = new DriveServiceAdapter(makeService({ files }));
    const result = await adapter.retrieveRelevantFiles({ userId: "u", query: "q", maxItems: 10 });
    expect(result.map((f) => f.id)).toEqual(["a", "b", "c"]);
  });
});

describe("DriveServiceAdapter mapping", () => {
  it("maps every compatible field", async () => {
    const file = makeFile();
    const adapter = new DriveServiceAdapter(makeService({ files: [file] }));
    const [mapped] = await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(mapped).toEqual({
      id: "file-1",
      title: "Q3 Report.pdf",
      content: "",
      timestamp: "2026-08-05T10:00:00Z",
      mimeType: "application/pdf",
      path: "folder-a/folder-b",
      owner: "Alice Chen",
    });
  });

  it("maps the production name to title", async () => {
    const adapter = new DriveServiceAdapter(
      makeService({ files: [makeFile({ name: "Budget.xlsx" })] }),
    );
    const [mapped] = await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(mapped.title).toBe("Budget.xlsx");
  });

  it("normalizes a missing name to an empty title", async () => {
    const adapter = new DriveServiceAdapter(
      makeService({ files: [makeFile({ name: "" })] }),
    );
    const [mapped] = await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(mapped.title).toBe("");
  });

  it("maps content to an empty string (production exposes no file text)", async () => {
    const adapter = new DriveServiceAdapter(makeService({ files: [makeFile()] }));
    const [mapped] = await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(mapped.content).toBe("");
  });

  it("maps production modifiedTime to timestamp", async () => {
    const adapter = new DriveServiceAdapter(
      makeService({ files: [makeFile({ modifiedTime: "2026-08-01T09:30:00Z" })] }),
    );
    const [mapped] = await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(mapped.timestamp).toBe("2026-08-01T09:30:00Z");
  });

  it("maps a null modifiedTime to an undefined timestamp", async () => {
    const adapter = new DriveServiceAdapter(
      makeService({ files: [makeFile({ modifiedTime: null })] }),
    );
    const [mapped] = await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(mapped.timestamp).toBeUndefined();
  });

  it("maps the production mimeType", async () => {
    const adapter = new DriveServiceAdapter(
      makeService({ files: [makeFile({ mimeType: "text/plain" })] }),
    );
    const [mapped] = await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(mapped.mimeType).toBe("text/plain");
  });

  it("joins the parents array into a slash-separated path", async () => {
    const adapter = new DriveServiceAdapter(
      makeService({ files: [makeFile({ parents: ["team", "eng", "docs"] })] }),
    );
    const [mapped] = await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(mapped.path).toBe("team/eng/docs");
  });

  it("omits path when parents is empty", async () => {
    const adapter = new DriveServiceAdapter(makeService({ files: [makeFile({ parents: [] })] }));
    const [mapped] = await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(mapped.path).toBeUndefined();
  });

  it("omits path when parents is null", async () => {
    const adapter = new DriveServiceAdapter(makeService({ files: [makeFile({ parents: null })] }));
    const [mapped] = await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(mapped.path).toBeUndefined();
  });

  it("maps the first owner's displayName", async () => {
    const adapter = new DriveServiceAdapter(
      makeService({ files: [makeFile({ owners: [{ displayName: "Bob", emailAddress: "bob@x.com" }] })] }),
    );
    const [mapped] = await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(mapped.owner).toBe("Bob");
  });

  it("falls back to the owner emailAddress when no displayName", async () => {
    const adapter = new DriveServiceAdapter(
      makeService({ files: [makeFile({ owners: [{ displayName: "", emailAddress: "bob@x.com" }] })] }),
    );
    const [mapped] = await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(mapped.owner).toBe("bob@x.com");
  });

  it("maps null owners to an undefined owner", async () => {
    const adapter = new DriveServiceAdapter(makeService({ files: [makeFile({ owners: null })] }));
    const [mapped] = await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(mapped.owner).toBeUndefined();
  });

  it("never invents a relevance score (omitted)", async () => {
    const adapter = new DriveServiceAdapter(makeService({ files: [makeFile()] }));
    const [mapped] = await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(mapped.relevance).toBeUndefined();
  });

  it("never invents an importance level (omitted)", async () => {
    const adapter = new DriveServiceAdapter(makeService({ files: [makeFile()] }));
    const [mapped] = await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(mapped.importance).toBeUndefined();
  });

  it("returns new file objects (not the production summary references)", async () => {
    const file = makeFile();
    const adapter = new DriveServiceAdapter(makeService({ files: [file] }));
    const [mapped] = await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(mapped).not.toBe(file);
  });

  it("does not mutate the production file objects", async () => {
    const file = makeFile();
    const snapshot = JSON.parse(JSON.stringify(file)) as ProductionDriveFile;
    const adapter = new DriveServiceAdapter(makeService({ files: [file] }));
    await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(file).toEqual(snapshot);
  });
});

describe("DriveServiceAdapter responses", () => {
  it("returns an empty list for an empty production response", async () => {
    const adapter = new DriveServiceAdapter(makeService({ files: [] }));
    await expect(
      adapter.retrieveRelevantFiles({ userId: "u", query: "q" }),
    ).resolves.toEqual([]);
  });

  it("maps multiple files preserving order", async () => {
    const files = [makeFile({ id: "f1" }), makeFile({ id: "f2" }), makeFile({ id: "f3" })];
    const adapter = new DriveServiceAdapter(makeService({ files }));
    const result = await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(result.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
  });

  it("handles a large production response", async () => {
    const files = Array.from({ length: 1000 }, (_, i) => makeFile({ id: `file-${i}` }));
    const adapter = new DriveServiceAdapter(makeService({ files }));
    const result = await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(result).toHaveLength(1000);
    expect(result[999].id).toBe("file-999");
  });

  it("is deterministic across repeated calls", async () => {
    const files = [makeFile({ id: "a" }), makeFile({ id: "b" })];
    const adapter = new DriveServiceAdapter(makeService({ files }));
    const options = { userId: "u", query: "q" };
    const first = await adapter.retrieveRelevantFiles(options);
    const second = await adapter.retrieveRelevantFiles(options);
    expect(second).toEqual(first);
  });
});

describe("DriveServiceAdapter error propagation", () => {
  it("forwards an async searchFiles rejection (never swallowed)", async () => {
    const error = new Error("drive search down");
    const adapter = new DriveServiceAdapter(makeService({ searchError: error }));
    await expect(
      adapter.retrieveRelevantFiles({ userId: "u", query: "q" }),
    ).rejects.toBe(error);
  });

  it("forwards an async listFiles rejection (never swallowed)", async () => {
    const error = new Error("drive list down");
    const adapter = new DriveServiceAdapter(makeService({ listError: error }));
    await expect(
      adapter.retrieveRelevantFiles({ userId: "u", query: "" }),
    ).rejects.toBe(error);
  });

  it("forwards a synchronous searchFiles throw", async () => {
    const error = new Error("sync boom");
    const service = makeService();
    service.searchFiles.mockImplementation(() => {
      throw error;
    });
    const adapter = new DriveServiceAdapter(service);
    await expect(
      adapter.retrieveRelevantFiles({ userId: "u", query: "q" }),
    ).rejects.toBe(error);
  });

  it("forwards a synchronous listFiles throw", async () => {
    const error = new Error("sync list boom");
    const service = makeService();
    service.listFiles.mockImplementation(() => {
      throw error;
    });
    const adapter = new DriveServiceAdapter(service);
    await expect(
      adapter.retrieveRelevantFiles({ userId: "u", query: "" }),
    ).rejects.toBe(error);
  });
});

describe("DriveServiceAdapter retry behavior", () => {
  it("calls searchFiles exactly once on success", async () => {
    const service = makeService({ files: [makeFile()] });
    const adapter = new DriveServiceAdapter(service);
    await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(service.searchFiles).toHaveBeenCalledTimes(1);
  });

  it("calls listFiles exactly once on success", async () => {
    const service = makeService({ files: [makeFile()] });
    const adapter = new DriveServiceAdapter(service);
    await adapter.retrieveRelevantFiles({ userId: "u", query: "" });
    expect(service.listFiles).toHaveBeenCalledTimes(1);
  });

  it("never retries a failing search (single delegation)", async () => {
    const service = makeService({ searchError: new Error("down") });
    const adapter = new DriveServiceAdapter(service);
    await adapter.retrieveRelevantFiles({ userId: "u", query: "q" }).catch(() => undefined);
    expect(service.searchFiles).toHaveBeenCalledTimes(1);
  });
});

describe("DriveServiceAdapter immutability", () => {
  it("does not mutate the args object passed to retrieveRelevantFiles", async () => {
    const service = makeService({ files: [makeFile()] });
    const adapter = new DriveServiceAdapter(service);
    const args = { userId: "u", query: "report", history: ["hi"], maxItems: 5 };
    const snapshot = { ...args };
    await adapter.retrieveRelevantFiles(args);
    expect(args).toEqual(snapshot);
  });

  it("does not mutate the production files array", async () => {
    const files = [makeFile({ id: "a" }), makeFile({ id: "b" })];
    const snapshot = JSON.parse(JSON.stringify(files)) as ProductionDriveFile[];
    const adapter = new DriveServiceAdapter(makeService({ files }));
    await adapter.retrieveRelevantFiles({ userId: "u", query: "q" });
    expect(files).toEqual(snapshot);
  });
});

describe("DriveServiceAdapter DriveSource integration", () => {
  it("satisfies the DriveSource contract end-to-end", async () => {
    const service = makeService({
      files: [makeFile({ id: "f1", name: "Proposal.docx", mimeType: "text/plain", parents: ["docs"] })],
    });
    const adapter = new DriveServiceAdapter(service);
    const source = new DriveSource(adapter);
    const query: RetrievalQuery = { userId: "user-1", query: "proposal" };
    const contexts = await source.retrieve(query);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      id: "f1",
      source: "drive",
      title: "Proposal.docx",
    });
    expect(contexts[0].metadata).toMatchObject({ mimeType: "text/plain", path: "docs" });
    expect(service.searchFiles).toHaveBeenCalledWith("proposal", undefined);
  });

  it("drives DriveSource isAvailable through the adapter", async () => {
    const adapter = new DriveServiceAdapter(makeService());
    const source = new DriveSource(adapter);
    await expect(source.isAvailable("user-1")).resolves.toBe(true);
  });

  it("reports unavailability through DriveSource when the service rejects", async () => {
    const adapter = new DriveServiceAdapter(
      makeService({ availabilityError: new Error("not connected") }),
    );
    const source = new DriveSource(adapter);
    await expect(source.isAvailable("user-1")).resolves.toBe(false);
  });

  it("defaults relevance to 0.5 downstream when the adapter omits it", async () => {
    const adapter = new DriveServiceAdapter(makeService({ files: [makeFile()] }));
    const source = new DriveSource(adapter);
    const contexts = await source.retrieve({ userId: "u", query: "q" });
    expect(contexts[0].relevance).toBe(0.5);
  });
});
