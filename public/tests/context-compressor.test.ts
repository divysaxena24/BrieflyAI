import { describe, it, expect } from "vitest";
import { ContextCompressor, TRUNCATION_MARKER } from "@/lib/context/contextCompressor";
import type { RankedContext } from "@/lib/context/types";

/** Long content used for truncation assertions (36 characters). */
const LONG_CONTENT = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Build a valid RankedContext fixture. */
function makeRanked(overrides: Partial<RankedContext> = {}): RankedContext {
  return {
    id: "ctx-1",
    source: "gmail",
    title: "Title",
    content: LONG_CONTENT,
    timestamp: null,
    relevance: 0.5,
    tokenEstimate: 10,
    truncated: false,
    compressed: false,
    metadata: { kind: "email", entityId: "e1" },
    permissions: null,
    score: 0.5,
    ...overrides,
  };
}

const compressor = new ContextCompressor();

describe("ContextCompressor basics", () => {
  it("returns an empty result for empty input", () => {
    expect(compressor.compress([], 10)).toEqual({ contexts: [], usedTokens: 0, remainingTokens: 10 });
  });

  it("returns an empty result for a zero budget", () => {
    expect(compressor.compress([makeRanked()], 0)).toEqual({ contexts: [], usedTokens: 0, remainingTokens: 0 });
  });

  it("returns an empty result for a negative budget", () => {
    expect(compressor.compress([makeRanked()], -5)).toEqual({ contexts: [], usedTokens: 0, remainingTokens: -5 });
  });
});

describe("ContextCompressor fitting", () => {
  it("keeps a single item that fits exactly", () => {
    const item = makeRanked({ tokenEstimate: 5, content: "hello" });
    const result = compressor.compress([item], 5);
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]!.content).toBe("hello");
    expect(result.contexts[0]!.truncated).toBe(false);
    expect(result.usedTokens).toBe(5);
    expect(result.remainingTokens).toBe(0);
  });

  it("keeps multiple items that fit exactly", () => {
    const items = [
      makeRanked({ id: "a", tokenEstimate: 2 }),
      makeRanked({ id: "b", tokenEstimate: 3 }),
      makeRanked({ id: "c", tokenEstimate: 5 }),
    ];
    const result = compressor.compress(items, 10);
    expect(result.contexts).toHaveLength(3);
    expect(result.remainingTokens).toBe(0);
    expect(result.usedTokens).toBe(10);
  });

  it("keeps everything when the budget is larger than the total", () => {
    const items = [
      makeRanked({ id: "a", tokenEstimate: 2 }),
      makeRanked({ id: "b", tokenEstimate: 3 }),
    ];
    const result = compressor.compress(items, 100);
    expect(result.contexts).toHaveLength(2);
    expect(result.remainingTokens).toBe(95);
    expect(result.usedTokens).toBe(5);
  });

  it("keeps zero-estimate items without consuming budget", () => {
    const item = makeRanked({ id: "free", tokenEstimate: 0, content: "freebie" });
    const result = compressor.compress([item], 5);
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]!.content).toBe("freebie");
    expect(result.remainingTokens).toBe(5);
    expect(result.usedTokens).toBe(0);
  });

  it("does not truncate an item that fits the exact remaining budget", () => {
    const items = [
      makeRanked({ id: "a", tokenEstimate: 3 }),
      makeRanked({ id: "b", tokenEstimate: 5, content: "fits exactly" }),
    ];
    const result = compressor.compress(items, 8);
    expect(result.contexts[1]!.content).toBe("fits exactly");
    expect(result.contexts[1]!.truncated).toBe(false);
    expect(result.remainingTokens).toBe(0);
  });
});

describe("ContextCompressor truncation", () => {
  it("truncates an item that exceeds the remaining budget", () => {
    const items = [
      makeRanked({ id: "a", tokenEstimate: 3, content: "AAA" }),
      makeRanked({ id: "b", tokenEstimate: 10, content: LONG_CONTENT }),
    ];
    const result = compressor.compress(items, 7);
    // remaining 4 → 16 chars + marker
    expect(result.contexts[1]!.content).toBe("0123456789ABCDEF" + TRUNCATION_MARKER);
  });

  it("sets the truncated flag", () => {
    const result = compressor.compress([makeRanked({ tokenEstimate: 10 })], 4);
    expect(result.contexts[0]!.truncated).toBe(true);
  });

  it("sets the compressed flag", () => {
    const result = compressor.compress([makeRanked({ tokenEstimate: 10 })], 4);
    expect(result.contexts[0]!.compressed).toBe(true);
  });

  it("records originalTokens as the previous estimate", () => {
    const result = compressor.compress([makeRanked({ tokenEstimate: 10 })], 4);
    expect(result.contexts[0]!.originalTokens).toBe(10);
  });

  it("updates tokenEstimate to the remaining budget", () => {
    const items = [
      makeRanked({ id: "a", tokenEstimate: 3, content: "AAA" }),
      makeRanked({ id: "b", tokenEstimate: 10 }),
    ];
    const result = compressor.compress(items, 7);
    expect(result.contexts[1]!.tokenEstimate).toBe(4);
  });

  it("leaves remainingTokens at zero after truncation", () => {
    const result = compressor.compress([makeRanked({ tokenEstimate: 10 })], 4);
    expect(result.remainingTokens).toBe(0);
  });

  it("stops processing after truncation", () => {
    const items = [
      makeRanked({ id: "a", tokenEstimate: 3, content: "AAA" }),
      makeRanked({ id: "b", tokenEstimate: 10 }),
      makeRanked({ id: "c", tokenEstimate: 1, content: "should be ignored" }),
    ];
    const result = compressor.compress(items, 7);
    expect(result.contexts.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("truncates a huge item down to the remaining budget", () => {
    const result = compressor.compress([makeRanked({ tokenEstimate: 1_000_000 })], 5);
    expect(result.contexts[0]!.content).toBe("0123456789ABCDEFGHIJ" + TRUNCATION_MARKER);
    expect(result.contexts[0]!.tokenEstimate).toBe(5);
    expect(result.contexts[0]!.originalTokens).toBe(1_000_000);
  });

  it("supports one-token truncation (4 characters + marker)", () => {
    const item = makeRanked({ tokenEstimate: 5, content: "abcdefghij" });
    const result = compressor.compress([item], 1);
    expect(result.contexts[0]!.content).toBe("abcd" + TRUNCATION_MARKER);
    expect(result.contexts[0]!.tokenEstimate).toBe(1);
  });

  it("truncates the first item when it exceeds the budget", () => {
    const result = compressor.compress([makeRanked({ tokenEstimate: 10 })], 4);
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]!.content).toBe("0123456789ABCDEF" + TRUNCATION_MARKER);
    expect(result.contexts[0]!.truncated).toBe(true);
  });

  it("truncates the last item after earlier items fit", () => {
    const items = [
      makeRanked({ id: "a", tokenEstimate: 2, content: "aa" }),
      makeRanked({ id: "b", tokenEstimate: 3, content: "bbb" }),
      makeRanked({ id: "c", tokenEstimate: 10 }),
    ];
    const result = compressor.compress(items, 7);
    expect(result.contexts.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(result.contexts[2]!.truncated).toBe(true);
    expect(result.contexts[2]!.content).toBe("01234567" + TRUNCATION_MARKER); // 2 tokens × 4
    expect(result.remainingTokens).toBe(0);
  });

  it("truncates exactly once (no further processing after truncation)", () => {
    const items = [
      makeRanked({ id: "a", tokenEstimate: 1, content: "a" }),
      makeRanked({ id: "b", tokenEstimate: 1, content: "b" }),
      makeRanked({ id: "c", tokenEstimate: 10 }),
      makeRanked({ id: "d", tokenEstimate: 1, content: "d" }),
    ];
    const result = compressor.compress(items, 4);
    expect(result.contexts.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(result.contexts.filter((c) => c.truncated)).toHaveLength(1);
  });

  it("handles empty content (marker only)", () => {
    const item = makeRanked({ tokenEstimate: 10, content: "" });
    const result = compressor.compress([item], 3);
    expect(result.contexts[0]!.content).toBe(TRUNCATION_MARKER);
    expect(result.contexts[0]!.tokenEstimate).toBe(3);
  });

  it("truncates unicode content by code points", () => {
    const item = makeRanked({ tokenEstimate: 10, content: "a😀b😃c😄" });
    const result = compressor.compress([item], 2);
    // 2 tokens × 4 = 8 code points ≥ all 6 code points → full content + marker
    expect(result.contexts[0]!.content).toBe("a😀b😃c😄" + TRUNCATION_MARKER);
  });

  it("truncates long content", () => {
    const item = makeRanked({ tokenEstimate: 100, content: "x".repeat(1000) });
    const result = compressor.compress([item], 25);
    expect(result.contexts[0]!.content).toBe("x".repeat(100) + TRUNCATION_MARKER);
    expect(result.contexts[0]!.tokenEstimate).toBe(25);
  });

  it("keeps an already-truncated item unchanged when it fits", () => {
    const item = makeRanked({
      tokenEstimate: 3,
      truncated: true,
      compressed: true,
      content: "short",
      originalTokens: 10,
    });
    const result = compressor.compress([item], 5);
    expect(result.contexts[0]!.content).toBe("short");
    expect(result.contexts[0]!.truncated).toBe(true);
    expect(result.contexts[0]!.compressed).toBe(true);
    expect(result.contexts[0]!.originalTokens).toBe(10);
  });

  it("re-truncates an already-truncated item that still exceeds the budget", () => {
    const item = makeRanked({
      tokenEstimate: 10,
      truncated: true,
      compressed: true,
      content: LONG_CONTENT,
    });
    const result = compressor.compress([item], 3);
    expect(result.contexts[0]!.content).toBe("0123456789AB" + TRUNCATION_MARKER); // 3 × 4 = 12
    expect(result.contexts[0]!.originalTokens).toBe(10);
    expect(result.contexts[0]!.truncated).toBe(true);
    expect(result.contexts[0]!.tokenEstimate).toBe(3);
  });

  it("keeps a pre-compressed item unchanged when it fits", () => {
    const item = makeRanked({ tokenEstimate: 2, compressed: true, content: "already compressed" });
    const result = compressor.compress([item], 5);
    expect(result.contexts[0]!.content).toBe("already compressed");
    expect(result.contexts[0]!.compressed).toBe(true);
    expect(result.contexts[0]!.truncated).toBe(false);
  });
});

describe("ContextCompressor metrics and ordering", () => {
  it("reports usedTokens as the sum of kept estimates", () => {
    const items = [
      makeRanked({ id: "a", tokenEstimate: 2 }),
      makeRanked({ id: "b", tokenEstimate: 3 }),
      makeRanked({ id: "c", tokenEstimate: 5 }),
    ];
    const result = compressor.compress(items, 10);
    expect(result.usedTokens).toBe(10);
  });

  it("satisfies usedTokens + remainingTokens = budget", () => {
    const items = [makeRanked({ id: "a", tokenEstimate: 2 }), makeRanked({ id: "b", tokenEstimate: 3 })];
    const result = compressor.compress(items, 100);
    expect(result.usedTokens + result.remainingTokens).toBe(100);
  });

  it("reports the correct remainingTokens when everything fits", () => {
    const items = [makeRanked({ id: "a", tokenEstimate: 2 }), makeRanked({ id: "b", tokenEstimate: 3 })];
    expect(compressor.compress(items, 100).remainingTokens).toBe(95);
  });

  it("reports remainingTokens zero after truncation", () => {
    expect(compressor.compress([makeRanked({ tokenEstimate: 10 })], 4).remainingTokens).toBe(0);
  });

  it("preserves the original ordering", () => {
    const items = [
      makeRanked({ id: "a", tokenEstimate: 1, content: "a" }),
      makeRanked({ id: "b", tokenEstimate: 10 }),
      makeRanked({ id: "c", tokenEstimate: 1, content: "c" }),
    ];
    const result = compressor.compress(items, 3);
    expect(result.contexts.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("ContextCompressor immutability and determinism", () => {
  it("never mutates the input array", () => {
    const items = [
      makeRanked({ id: "a", tokenEstimate: 1, content: "a" }),
      makeRanked({ id: "b", tokenEstimate: 10 }),
      makeRanked({ id: "c", tokenEstimate: 1, content: "c" }),
    ];
    const ids = items.map((c) => c.id);
    compressor.compress(items, 3);
    expect(items.map((c) => c.id)).toEqual(ids);
    expect(items).toHaveLength(3);
  });

  it("never mutates the input context objects", () => {
    const item = makeRanked({ tokenEstimate: 10, content: LONG_CONTENT, truncated: false, compressed: false });
    compressor.compress([item], 4);
    expect(item.content).toBe(LONG_CONTENT);
    expect(item.tokenEstimate).toBe(10);
    expect(item.truncated).toBe(false);
    expect(item.compressed).toBe(false);
    expect(item.originalTokens).toBeUndefined();
  });

  it("leaves metadata objects untouched and shared", () => {
    const metadata = { kind: "email" as const, entityId: "e1", threadId: "t1" };
    const item = makeRanked({ metadata });
    const result = compressor.compress([item], 4);
    expect(result.contexts[0]!.metadata).toBe(metadata);
    expect(metadata).toEqual({ kind: "email", entityId: "e1", threadId: "t1" });
  });

  it("leaves permissions untouched and shared", () => {
    const permissions = { integrationId: "i1", platform: "gmail", scopes: ["read"], level: "read" as const };
    const item = makeRanked({ permissions });
    const result = compressor.compress([item], 4);
    expect(result.contexts[0]!.permissions).toBe(permissions);
    expect(permissions).toEqual({ integrationId: "i1", platform: "gmail", scopes: ["read"], level: "read" });
  });

  it("returns new top-level objects", () => {
    const items = [makeRanked({ id: "a", tokenEstimate: 1, content: "a" })];
    const result = compressor.compress(items, 5);
    expect(result.contexts[0]).not.toBe(items[0]);
  });

  it("is deterministic for identical inputs", () => {
    const items = [
      makeRanked({ id: "a", tokenEstimate: 2, content: "aa" }),
      makeRanked({ id: "b", tokenEstimate: 10 }),
    ];
    const first = compressor.compress(items, 6);
    const second = compressor.compress(items, 6);
    expect(first).toEqual(second);
  });
});
