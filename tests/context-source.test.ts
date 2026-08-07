import { describe, it, expect } from "vitest";
import {
  ContextSourceBase,
  sortByPriority,
  filterAvailableSources,
} from "@/lib/context/sources/contextSource";
import { MockContextSource } from "@/lib/context/sources/mockSource";
import type { Context } from "@/lib/context/types";

/** Minimal concrete subclass used to exercise the abstract base class. */
class TestSource extends ContextSourceBase {
  async retrieve(): Promise<Context[]> {
    return [];
  }
}

/** Build a valid Context fixture with sane defaults. */
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

describe("ContextSourceBase", () => {
  it("stores id and priority from the constructor", () => {
    const source = new TestSource("gmail", 5);
    expect(source.id).toBe("gmail");
    expect(source.priority).toBe(5);
  });

  it("isAvailable defaults to true", async () => {
    const source = new TestSource("gmail", 5);
    await expect(source.isAvailable("user-1")).resolves.toBe(true);
  });

  it("exposes the correct ContextSource surface", () => {
    const source = new TestSource("github", 10);
    expect(typeof source.retrieve).toBe("function");
    expect(typeof source.isAvailable).toBe("function");
  });
});

describe("MockContextSource", () => {
  it("returns a deep clone of the provided contexts", async () => {
    const contexts = [makeContext()];
    const source = new MockContextSource("mock", 1, contexts);
    const result = await source.retrieve({ userId: "user-1", query: "q" });

    expect(result).toEqual(contexts);
    expect(result).not.toBe(contexts);
    expect(result[0]).not.toBe(contexts[0]);
    expect(result[0]!.metadata).not.toBe(contexts[0]!.metadata);
  });

  it("does not mutate internal data when the caller mutates results", async () => {
    const contexts = [
      makeContext({ id: "a", content: "first" }),
      makeContext({ id: "b", content: "second" }),
    ];
    const source = new MockContextSource("mock", 1, contexts);

    const first = await source.retrieve({ userId: "user-1", query: "q" });
    first[0]!.content = "MUTATED";
    first[0]!.metadata.kind = "email";
    first.length = 0;

    const second = await source.retrieve({ userId: "user-1", query: "q" });
    expect(second).toEqual(contexts);
  });

  it("isAvailable returns true by default", async () => {
    const source = new MockContextSource("mock", 1, []);
    await expect(source.isAvailable("user-1")).resolves.toBe(true);
  });

  it("isAvailable returns false when constructed with available=false", async () => {
    const source = new MockContextSource("mock", 1, [], false);
    await expect(source.isAvailable("user-1")).resolves.toBe(false);
  });
});

describe("sortByPriority", () => {
  it("sorts highest priority first", () => {
    const sources = [
      new MockContextSource("low", 1, []),
      new MockContextSource("high", 3, []),
      new MockContextSource("mid", 2, []),
    ];
    expect(sortByPriority(sources).map((s) => s.id)).toEqual(["high", "mid", "low"]);
  });

  it("sorts a reversed (ascending) input correctly", () => {
    const sources = [
      new MockContextSource("a", 1, []),
      new MockContextSource("b", 2, []),
      new MockContextSource("c", 3, []),
    ];
    expect(sortByPriority(sources).map((s) => s.id)).toEqual(["c", "b", "a"]);
  });

  it("is stable for equal priorities (preserves input order)", () => {
    const sources = [
      new MockContextSource("x1", 2, []),
      new MockContextSource("x2", 2, []),
      new MockContextSource("x3", 1, []),
      new MockContextSource("x4", 2, []),
    ];
    expect(sortByPriority(sources).map((s) => s.id)).toEqual(["x1", "x2", "x4", "x3"]);
  });

  it("does not mutate the input array", () => {
    const sources = [
      new MockContextSource("a", 1, []),
      new MockContextSource("b", 3, []),
      new MockContextSource("c", 2, []),
    ];
    sortByPriority(sources);
    expect(sources.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(sources.map((s) => s.priority)).toEqual([1, 3, 2]);
  });

  it("returns a new array without mutating the input", () => {
    const sources = [new MockContextSource("a", 1, [])];
    const result = sortByPriority(sources);
    expect(result).not.toBe(sources);
    expect(sources.map((s) => s.id)).toEqual(["a"]);
  });

  it("handles an empty array", () => {
    expect(sortByPriority([])).toEqual([]);
  });
});

describe("filterAvailableSources", () => {
  it("returns all sources when every source is available", async () => {
    const sources = [
      new MockContextSource("a", 1, []),
      new MockContextSource("b", 2, []),
    ];
    const filtered = await filterAvailableSources(sources, "user-1");
    expect(filtered.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("returns only available sources for partial availability", async () => {
    const sources = [
      new MockContextSource("a", 1, [], true),
      new MockContextSource("b", 2, [], false),
      new MockContextSource("c", 3, [], true),
    ];
    const filtered = await filterAvailableSources(sources, "user-1");
    expect(filtered.map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("returns an empty array when no source is available", async () => {
    const sources = [
      new MockContextSource("a", 1, [], false),
      new MockContextSource("b", 2, [], false),
    ];
    expect(await filterAvailableSources(sources, "user-1")).toEqual([]);
  });

  it("preserves input order", async () => {
    const sources = [
      new MockContextSource("z", 10, []),
      new MockContextSource("a", 1, []),
      new MockContextSource("m", 5, []),
    ];
    const filtered = await filterAvailableSources(sources, "user-1");
    expect(filtered.map((s) => s.id)).toEqual(["z", "a", "m"]);
  });

  it("passes the userId through to isAvailable", async () => {
    const calls: string[] = [];
    class RecordingSource extends ContextSourceBase {
      async retrieve(): Promise<Context[]> {
        return [];
      }
      async isAvailable(userId: string): Promise<boolean> {
        calls.push(userId);
        return true;
      }
    }

    await filterAvailableSources([new RecordingSource("r", 1)], "user-42");
    expect(calls).toEqual(["user-42"]);
  });
});
