import { afterEach, describe, it, expect, vi } from "vitest";
import { ContextBuilder } from "@/lib/context/contextBuilder";
import { ContextSourceRegistry } from "@/lib/context/sourceRegistry";
import { ContextSourceBase } from "@/lib/context/sources/contextSource";
import { MockContextSource } from "@/lib/context/sources/mockSource";
import type { MemoryService } from "@/lib/context/sources/memorySource";
import type { GmailService } from "@/lib/context/sources/gmailSource";
import * as sourceHelpers from "@/lib/context/sources/contextSource";
import type { Context, RetrievalQuery } from "@/lib/context/types";

/** Build a valid RetrievalQuery fixture. */
function makeQuery(overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return { userId: "user-1", query: "hello", ...overrides };
}

/** Build a valid Context fixture. */
function makeContext(overrides: Partial<Context> = {}): Context {
  return {
    id: "ctx-1",
    source: "mock",
    title: "Title",
    content: "Content",
    timestamp: "2026-08-07T00:00:00.000Z",
    relevance: 0.5,
    tokenEstimate: 10,
    truncated: false,
    compressed: false,
    metadata: { kind: "memory", entityId: "mem-1" },
    permissions: null,
    ...overrides,
  };
}

/** Source that records how it was invoked and returns fresh arrays. */
class RecordingSource extends ContextSourceBase {
  retrieveCalls = 0;
  isAvailableCalls = 0;
  lastQuery: RetrievalQuery | null = null;
  lastIsAvailableUserId: string | null = null;
  readonly results: Context[];

  constructor(id: string, priority: number, results: Context[], private availability = true) {
    super(id, priority);
    this.results = results;
  }

  async isAvailable(userId: string): Promise<boolean> {
    this.isAvailableCalls += 1;
    this.lastIsAvailableUserId = userId;
    return this.availability;
  }

  async retrieve(query: RetrievalQuery): Promise<Context[]> {
    this.retrieveCalls += 1;
    this.lastQuery = query;
    return [...this.results];
  }
}

/** Source that always rejects during retrieval. */
class ThrowingSource extends ContextSourceBase {
  async retrieve(): Promise<Context[]> {
    throw new Error(`retrieve failed for ${this.id}`);
  }
}

/** Source whose isAvailable always rejects. */
class ThrowingAvailabilitySource extends ContextSourceBase {
  async isAvailable(): Promise<boolean> {
    throw new Error(`isAvailable failed for ${this.id}`);
  }

  async retrieve(): Promise<Context[]> {
    return [makeContext({ id: `ctx-${this.id}` })];
  }
}

/** Mock memory service returning one memory. */
function makeMemoryService(
  overrides: { available?: boolean; retrieveError?: unknown } = {},
): MemoryService {
  return {
    isAvailable: vi.fn(async () => overrides.available ?? true),
    retrieveRelevantMemory: vi.fn(async () => {
      if (overrides.retrieveError !== undefined) throw overrides.retrieveError;
      return [{ id: "mem-1", title: "Memory", content: "Remembered fact", timestamp: null }];
    }),
  } as unknown as MemoryService;
}

/** Mock gmail service returning one email. */
function makeGmailService(
  overrides: { available?: boolean; retrieveError?: unknown } = {},
): GmailService {
  return {
    isAvailable: vi.fn(async () => overrides.available ?? true),
    retrieveRelevantEmails: vi.fn(async () => {
      if (overrides.retrieveError !== undefined) throw overrides.retrieveError;
      return [{ id: "e-1", subject: "Subject", body: "Email body", timestamp: null }];
    }),
  } as unknown as GmailService;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ContextBuilder construction", () => {
  it("builds with an empty source list and returns []", async () => {
    const builder = new ContextBuilder([]);
    await expect(builder.build(makeQuery())).resolves.toEqual([]);
  });

  it("builds with a single source", async () => {
    const builder = new ContextBuilder([
      new MockContextSource("a", 1, [makeContext({ id: "a1" })]),
    ]);
    const result = await builder.build(makeQuery());
    expect(result.map((c) => c.id)).toEqual(["a1"]);
  });

  it("builds with multiple sources", async () => {
    const builder = new ContextBuilder([
      new MockContextSource("a", 1, [makeContext({ id: "a1" })]),
      new MockContextSource("b", 1, [makeContext({ id: "b1" })]),
      new MockContextSource("c", 1, [makeContext({ id: "c1" })]),
    ]);
    const result = await builder.build(makeQuery());
    expect(result.map((c) => c.id)).toEqual(["a1", "b1", "c1"]);
  });

  it("snapshots the source list at construction time", async () => {
    const sources = [new MockContextSource("a", 1, [])];
    const builder = new ContextBuilder(sources);
    // Mutating the caller's array must not affect the builder.
    sources.push(new MockContextSource("b", 2, [makeContext({ id: "b-ctx" })]));
    const result = await builder.build(makeQuery());
    expect(result).toEqual([]);
  });
});

describe("ContextBuilder availability filtering", () => {
  it("ignores unavailable sources", async () => {
    const unavailable = new RecordingSource("unavailable", 10, [makeContext()], false);
    const builder = new ContextBuilder([unavailable]);
    const result = await builder.build(makeQuery());
    expect(result).toEqual([]);
    expect(unavailable.retrieveCalls).toBe(0);
  });

  it("never retrieves from an unavailable source even when it has highest priority", async () => {
    const high = new RecordingSource("high", 100, [makeContext({ id: "high-ctx" })], false);
    const low = new RecordingSource("low", 1, [makeContext({ id: "low-ctx" })], true);
    const builder = new ContextBuilder([high, low]);
    const result = await builder.build(makeQuery());
    expect(result.map((c) => c.id)).toEqual(["low-ctx"]);
    expect(high.retrieveCalls).toBe(0);
  });

  it("calls isAvailable on every source exactly once", async () => {
    const a = new RecordingSource("a", 1, []);
    const b = new RecordingSource("b", 1, []);
    const builder = new ContextBuilder([a, b]);
    await builder.build(makeQuery());
    expect(a.isAvailableCalls).toBe(1);
    expect(b.isAvailableCalls).toBe(1);
  });

  it("passes the query userId to every source's isAvailable", async () => {
    const a = new RecordingSource("a", 1, []);
    const b = new RecordingSource("b", 1, []);
    const builder = new ContextBuilder([a, b]);
    await builder.build(makeQuery({ userId: "user-99" }));
    expect(a.isAvailableCalls).toBe(1);
    expect(b.isAvailableCalls).toBe(1);
    expect(a.lastIsAvailableUserId).toBe("user-99");
    expect(b.lastIsAvailableUserId).toBe("user-99");
  });

  it("continues safely when a source's isAvailable throws", async () => {
    const good = new MockContextSource("good", 2, [makeContext({ id: "good-ctx" })]);
    const bad = new ThrowingAvailabilitySource("bad", 1);
    const builder = new ContextBuilder([good, bad]);
    const result = await builder.build(makeQuery());
    expect(result.map((c) => c.id)).toEqual(["good-ctx"]);
  });
});

describe("ContextBuilder retrieval + ordering", () => {
  it("collects contexts when every source is available", async () => {
    const a = new MockContextSource("a", 1, [makeContext({ id: "a1" }), makeContext({ id: "a2" })]);
    const b = new MockContextSource("b", 1, [makeContext({ id: "b1" })]);
    const builder = new ContextBuilder([a, b]);
    const result = await builder.build(makeQuery());
    expect(result.map((c) => c.id)).toEqual(["a1", "a2", "b1"]);
  });

  it("flattens multiple sources into one list", async () => {
    const sources = ["a", "b", "c"].map((id) => new MockContextSource(id, 1, [makeContext({ id: `${id}-ctx` })]));
    const builder = new ContextBuilder(sources);
    const result = await builder.build(makeQuery());
    expect(result.map((c) => c.id)).toEqual(["a-ctx", "b-ctx", "c-ctx"]);
  });

  it("handles a source that returns zero contexts", async () => {
    const empty = new MockContextSource("empty", 2, []);
    const filled = new MockContextSource("filled", 1, [makeContext({ id: "filled-ctx" })]);
    const builder = new ContextBuilder([empty, filled]);
    const result = await builder.build(makeQuery());
    expect(result.map((c) => c.id)).toEqual(["filled-ctx"]);
  });

  it("orders higher-priority sources first", async () => {
    const low = new MockContextSource("low", 1, [makeContext({ id: "low-ctx" })]);
    const high = new MockContextSource("high", 10, [makeContext({ id: "high-ctx" })]);
    const builder = new ContextBuilder([low, high]);
    const result = await builder.build(makeQuery());
    expect(result.map((c) => c.id)).toEqual(["high-ctx", "low-ctx"]);
  });

  it("priority ordering overrides constructor order", async () => {
    const first = new MockContextSource("first", 1, [makeContext({ id: "first-ctx" })]);
    const second = new MockContextSource("second", 5, [makeContext({ id: "second-ctx" })]);
    const builder = new ContextBuilder([first, second]);
    const result = await builder.build(makeQuery());
    expect(result.map((c) => c.id)).toEqual(["second-ctx", "first-ctx"]);
  });

  it("keeps equal-priority sources in constructor order (stable sort)", async () => {
    const a = new MockContextSource("a", 1, [makeContext({ id: "a1" })]);
    const b = new MockContextSource("b", 1, [makeContext({ id: "b1" })]);
    const builder = new ContextBuilder([a, b]);
    const result = await builder.build(makeQuery());
    expect(result.map((c) => c.id)).toEqual(["a1", "b1"]);
  });

  it("preserves retrieval order within each source", async () => {
    const a = new MockContextSource("a", 1, [
      makeContext({ id: "a-first" }),
      makeContext({ id: "a-second" }),
      makeContext({ id: "a-third" }),
    ]);
    const builder = new ContextBuilder([a]);
    const result = await builder.build(makeQuery());
    expect(result.map((c) => c.id)).toEqual(["a-first", "a-second", "a-third"]);
  });

  it("does not deduplicate — identical contexts from different sources both appear", async () => {
    const same = makeContext({ id: "same-ctx", source: "x" });
    const a = new MockContextSource("a", 2, [same]);
    const b = new MockContextSource("b", 1, [same]);
    const builder = new ContextBuilder([a, b]);
    const result = await builder.build(makeQuery());
    expect(result.map((c) => c.id)).toEqual(["same-ctx", "same-ctx"]);
  });

  it("calls sortByPriority on the available sources", async () => {
    const spy = vi.spyOn(sourceHelpers, "sortByPriority");
    const a = new MockContextSource("a", 1, []);
    const builder = new ContextBuilder([a]);
    await builder.build(makeQuery());
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("ContextBuilder failure isolation (Promise.allSettled)", () => {
  it("keeps successful contexts when one source throws", async () => {
    const good = new MockContextSource("good", 2, [makeContext({ id: "good-ctx" })]);
    const bad = new ThrowingSource("bad", 1);
    const builder = new ContextBuilder([good, bad]);
    const result = await builder.build(makeQuery());
    expect(result.map((c) => c.id)).toEqual(["good-ctx"]);
  });

  it("keeps successful contexts when two sources throw", async () => {
    const good = new MockContextSource("good", 3, [makeContext({ id: "good-ctx" })]);
    const bad1 = new ThrowingSource("bad1", 2);
    const bad2 = new ThrowingSource("bad2", 1);
    const builder = new ContextBuilder([good, bad1, bad2]);
    const result = await builder.build(makeQuery());
    expect(result.map((c) => c.id)).toEqual(["good-ctx"]);
  });

  it("returns [] when every source throws", async () => {
    const bad1 = new ThrowingSource("bad1", 2);
    const bad2 = new ThrowingSource("bad2", 1);
    const builder = new ContextBuilder([bad1, bad2]);
    await expect(builder.build(makeQuery())).resolves.toEqual([]);
  });

  it("never throws — a failing retrieve rejects the source, not the build", async () => {
    const bad = new ThrowingSource("bad", 1);
    const builder = new ContextBuilder([bad]);
    await expect(builder.build(makeQuery())).resolves.toEqual([]);
  });

  it("keeps successful contexts when availability and retrieve both fail elsewhere", async () => {
    const good = new MockContextSource("good", 3, [makeContext({ id: "good-ctx" })]);
    const badAvailability = new ThrowingAvailabilitySource("badavail", 2);
    const badRetrieve = new ThrowingSource("badretrieve", 1);
    const builder = new ContextBuilder([good, badAvailability, badRetrieve]);
    const result = await builder.build(makeQuery());
    expect(result.map((c) => c.id)).toEqual(["good-ctx"]);
  });

  it("drops non-array fulfilled results defensively", async () => {
    class WeirdSource extends ContextSourceBase {
      async retrieve(): Promise<Context[]> {
        return "not-an-array" as unknown as Context[];
      }
    }
    const builder = new ContextBuilder([new WeirdSource("weird", 1)]);
    await expect(builder.build(makeQuery())).resolves.toEqual([]);
  });
});

describe("ContextBuilder ContextSourceRegistry integration", () => {
  it("accepts the readonly source list produced by ContextSourceRegistry", async () => {
    const registry = new ContextSourceRegistry({
      memoryService: makeMemoryService(),
      gmailService: makeGmailService(),
    });
    const builder = new ContextBuilder(registry.getSources());
    const result = await builder.build(makeQuery());
    expect(result).toHaveLength(2);
    // memory has priority 100 > gmail 80.
    expect(result.map((c) => c.metadata.kind)).toEqual(["memory", "email"]);
  });

  it("builds from a registry configured with a single service", async () => {
    const registry = new ContextSourceRegistry({ memoryService: makeMemoryService() });
    const builder = new ContextBuilder(registry.getSources());
    const result = await builder.build(makeQuery());
    expect(result).toHaveLength(1);
    expect(result[0]!.metadata.kind).toBe("memory");
  });

  it("skips registry sources that report unavailable", async () => {
    const registry = new ContextSourceRegistry({
      memoryService: makeMemoryService({ available: false }),
      gmailService: makeGmailService(),
    });
    const builder = new ContextBuilder(registry.getSources());
    const result = await builder.build(makeQuery());
    expect(result).toHaveLength(1);
    expect(result[0]!.metadata.kind).toBe("email");
  });

  it("keeps successful registry sources when another's retrieve fails", async () => {
    const registry = new ContextSourceRegistry({
      memoryService: makeMemoryService(),
      gmailService: makeGmailService({ retrieveError: new Error("gmail down") }),
    });
    const builder = new ContextBuilder(registry.getSources());
    const result = await builder.build(makeQuery());
    expect(result).toHaveLength(1);
    expect(result[0]!.metadata.kind).toBe("memory");
  });
});

describe("ContextBuilder immutability", () => {
  it("never mutates the source arrays passed to the constructor", async () => {
    const sources = [new MockContextSource("a", 1, []), new MockContextSource("b", 3, [])];
    const builder = new ContextBuilder(sources);
    await builder.build(makeQuery());
    expect(sources.map((s) => s.id)).toEqual(["a", "b"]);
    expect(sources.map((s) => s.priority)).toEqual([1, 3]);
  });

  it("never mutates the contexts it returns", async () => {
    const contexts = [makeContext({ id: "orig" })];
    const builder = new ContextBuilder([new MockContextSource("a", 1, contexts)]);

    const first = await builder.build(makeQuery());
    first[0]!.content = "MUTATED";
    first[0]!.metadata.kind = "email";

    const second = await builder.build(makeQuery());
    expect(second).toEqual(contexts);
  });

  it("does not mutate the source instances", async () => {
    const contexts = [makeContext({ id: "c1" })];
    const source = new RecordingSource("a", 1, contexts);
    const builder = new ContextBuilder([source]);
    await builder.build(makeQuery());
    expect(source.results).toEqual(contexts);
    expect(source.results).toHaveLength(1);
    expect(source.isAvailableCalls).toBe(1);
    expect(source.retrieveCalls).toBe(1);
  });

  it("supports repeated independent builds", async () => {
    const builder = new ContextBuilder([new MockContextSource("a", 1, [makeContext({ id: "x" })])]);
    const first = await builder.build(makeQuery());
    const second = await builder.build(makeQuery({ query: "different" }));
    expect(first.map((c) => c.id)).toEqual(["x"]);
    expect(second.map((c) => c.id)).toEqual(["x"]);
  });
});

describe("ContextBuilder determinism", () => {
  it("produces identical output for identical sources across builds", async () => {
    const sources = [
      new MockContextSource("a", 2, [makeContext({ id: "a1" })]),
      new MockContextSource("b", 1, [makeContext({ id: "b1" })]),
    ];
    const builder = new ContextBuilder(sources);
    const first = await builder.build(makeQuery());
    const second = await builder.build(makeQuery());
    expect(second).toEqual(first);
  });
});

describe("ContextBuilder concurrency", () => {
  it("executes retrieval on every source concurrently", async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    class GatedSource extends ContextSourceBase {
      async retrieve(): Promise<Context[]> {
        started += 1;
        await gate;
        return [makeContext({ source: this.id })];
      }
    }

    const builder = new ContextBuilder([new GatedSource("a", 1), new GatedSource("b", 1)]);
    const buildPromise = builder.build(makeQuery());

    // Give both sources a chance to enter retrieve() while the gate is closed.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toBe(2);

    release();
    const result = await buildPromise;
    expect(result).toHaveLength(2);
  });

  it("passes the query through to every source's retrieve", async () => {
    const a = new RecordingSource("a", 1, [makeContext({ id: "a1" })]);
    const b = new RecordingSource("b", 1, [makeContext({ id: "b1" })]);
    const builder = new ContextBuilder([a, b]);
    const query = makeQuery({ userId: "user-77", query: "status update" });
    await builder.build(query);

    expect(a.retrieveCalls).toBe(1);
    expect(b.retrieveCalls).toBe(1);
    expect(a.lastQuery).toBe(query);
    expect(b.lastQuery).toBe(query);
  });
});

describe("ContextBuilder edge cases", () => {
  it("handles 100 sources", async () => {
    const sources = Array.from(
      { length: 100 },
      (_, i) => new MockContextSource(`s${i}`, i, [makeContext({ id: `ctx-${i}` })]),
    );
    const builder = new ContextBuilder(sources);
    const result = await builder.build(makeQuery());
    expect(result).toHaveLength(100);
    expect(new Set(result.map((c) => c.id)).size).toBe(100);
  });

  it("handles 1000 contexts", async () => {
    const contexts = Array.from({ length: 1000 }, (_, i) => makeContext({ id: `c${i}` }));
    const builder = new ContextBuilder([new MockContextSource("big", 1, contexts)]);
    const result = await builder.build(makeQuery());
    expect(result).toHaveLength(1000);
  });

  it("handles a mix of available, unavailable, and failing sources", async () => {
    const good = new MockContextSource("good", 3, [makeContext({ id: "good-ctx" })]);
    const unavailable = new RecordingSource("unavailable", 2, [makeContext({ id: "u-ctx" })], false);
    const failing = new ThrowingSource("failing", 1);
    const builder = new ContextBuilder([good, unavailable, failing]);
    const result = await builder.build(makeQuery());
    expect(result.map((c) => c.id)).toEqual(["good-ctx"]);
    expect(unavailable.retrieveCalls).toBe(0);
  });
});
