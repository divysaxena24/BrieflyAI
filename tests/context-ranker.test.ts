import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { ContextRanker } from "@/lib/context/contextRanker";
import {
  IMPORTANCE_SCORES,
  SOURCE_PRIORITY,
  MISSING_IMPORTANCE_SCORE,
  UNKNOWN_SOURCE_PRIORITY,
  INTENT_MATCH_SCORE,
  INTENT_DEFAULT_SCORE,
  RECENCY_HALF_LIFE_MS,
} from "@/lib/context/contextRanker";
import type { Context, RetrievalQuery } from "@/lib/context/types";

/** Fixed reference "now" for deterministic recency math. */
const NOW = new Date("2026-08-07T00:00:00.000Z");

/** Build a valid RetrievalQuery fixture (empty query → no intent match). */
function makeQuery(overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return { userId: "user-1", query: "", ...overrides };
}

/** Build a Context fixture; default = memory, no importance, null timestamp. */
function makeContext(overrides: Partial<Context> = {}): Context {
  return {
    id: "ctx-1",
    source: "memory",
    title: "Title",
    content: "Content",
    timestamp: null,
    relevance: 0.5,
    tokenEstimate: 10,
    truncated: false,
    compressed: false,
    metadata: { kind: "memory", entityId: "mem-1" },
    permissions: null,
    ...overrides,
  };
}

const ranker = new ContextRanker();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ContextRanker basics", () => {
  it("returns [] for empty input", () => {
    expect(ranker.rank([], makeQuery())).toEqual([]);
  });

  it("returns a single context with a numeric score in [0, 1]", () => {
    const context = makeContext();
    const result = ranker.rank([context], makeQuery());
    expect(result).toHaveLength(1);
    expect(typeof result[0]!.score).toBe("number");
    expect(result[0]!.score).toBeGreaterThanOrEqual(0);
    expect(result[0]!.score).toBeLessThanOrEqual(1);
  });

  it("preserves every original field on the ranked item", () => {
    const context = makeContext({ id: "abc", source: "gmail", content: "hello" });
    const [ranked] = ranker.rank([context], makeQuery());
    expect(ranked.id).toBe("abc");
    expect(ranked.source).toBe("gmail");
    expect(ranked.content).toBe("hello");
    expect(ranked.metadata).toBe(context.metadata);
    expect(ranked.permissions).toBeNull();
  });

  it("ranks multiple contexts without changing the count", () => {
    const contexts = [makeContext({ id: "a" }), makeContext({ id: "b" }), makeContext({ id: "c" })];
    expect(ranker.rank(contexts, makeQuery())).toHaveLength(3);
  });

  it("sorts by descending score", () => {
    const contexts = [
      makeContext({ id: "recent", timestamp: NOW.toISOString() }),
      makeContext({ id: "old", timestamp: new Date(NOW.getTime() - 48 * 60 * 60 * 1000).toISOString() }),
    ];
    const result = ranker.rank(contexts, makeQuery());
    expect(result.map((c) => c.id)).toEqual(["recent", "old"]);
    expect(result[0]!.score).toBeGreaterThan(result[1]!.score);
  });

  it("is stable for equal scores (preserves input order)", () => {
    const first = makeContext({ id: "first" });
    const second = makeContext({ id: "second" });
    const result = ranker.rank([first, second], makeQuery());
    expect(result.map((c) => c.id)).toEqual(["first", "second"]);
  });

  it("keeps tie ordering consistent across different sources with equal scores", () => {
    // gmail and github share source priority 0.9 → identical scores here.
    const gmail = makeContext({ id: "g", source: "gmail", metadata: { kind: "email", entityId: "1" } });
    const github = makeContext({ id: "gh", source: "github", metadata: { kind: "issue", entityId: "2" } });
    const result = ranker.rank([gmail, github], makeQuery());
    expect(result[0]!.score).toBeCloseTo(result[1]!.score, 10);
    expect(result.map((c) => c.id)).toEqual(["g", "gh"]);
  });
});

describe("ContextRanker recency", () => {
  // Baseline: memory source, missing importance, no intent → 0.425.
  it("scores a null timestamp with recency 0", () => {
    const result = ranker.rank([makeContext({ timestamp: null })], makeQuery());
    expect(result[0]!.score).toBeCloseTo(0.425, 5);
  });

  it("scores a current timestamp with recency ≈ 1", () => {
    const result = ranker.rank([makeContext({ timestamp: NOW.toISOString() })], makeQuery());
    expect(result[0]!.score).toBeCloseTo(0.775, 5);
  });

  it("applies exponential decay: 24h old scores 0.5 recency", () => {
    const old = new Date(NOW.getTime() - RECENCY_HALF_LIFE_MS).toISOString();
    const result = ranker.rank([makeContext({ timestamp: old })], makeQuery());
    expect(result[0]!.score).toBeCloseTo(0.6, 5); // 0.425 + 0.35 * 0.5
  });

  it("applies exponential decay: 48h old scores 0.25 recency", () => {
    const old = new Date(NOW.getTime() - 2 * RECENCY_HALF_LIFE_MS).toISOString();
    const result = ranker.rank([makeContext({ timestamp: old })], makeQuery());
    expect(result[0]!.score).toBeCloseTo(0.5125, 5); // 0.425 + 0.35 * 0.25
  });

  it("treats future timestamps as fully recent (clamped age)", () => {
    const future = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
    const result = ranker.rank([makeContext({ timestamp: future })], makeQuery());
    expect(result[0]!.score).toBeCloseTo(0.775, 5);
  });

  it("ranks newer contexts above older ones", () => {
    const recent = makeContext({ id: "r", timestamp: NOW.toISOString() });
    const old = makeContext({ id: "o", timestamp: new Date(NOW.getTime() - 6 * RECENCY_HALF_LIFE_MS).toISOString() });
    const result = ranker.rank([old, recent], makeQuery());
    expect(result.map((c) => c.id)).toEqual(["r", "o"]);
  });
});

describe("ContextRanker importance", () => {
  // Baseline without importance: memory + intent default → 0.3; + 0.25 * importance.
  it("maps critical to 1", () => {
    const result = ranker.rank([makeContext({ metadata: { kind: "email", entityId: "1", importance: "critical" } })], makeQuery());
    expect(result[0]!.score).toBeCloseTo(0.3 + 0.25 * IMPORTANCE_SCORES.critical, 5);
  });

  it("maps high to 0.8", () => {
    const result = ranker.rank([makeContext({ metadata: { kind: "email", entityId: "1", importance: "high" } })], makeQuery());
    expect(result[0]!.score).toBeCloseTo(0.3 + 0.25 * IMPORTANCE_SCORES.high, 5);
  });

  it("maps normal to 0.5", () => {
    const result = ranker.rank([makeContext({ metadata: { kind: "email", entityId: "1", importance: "normal" } })], makeQuery());
    expect(result[0]!.score).toBeCloseTo(0.3 + 0.25 * IMPORTANCE_SCORES.normal, 5);
  });

  it("maps low to 0.2", () => {
    const result = ranker.rank([makeContext({ metadata: { kind: "email", entityId: "1", importance: "low" } })], makeQuery());
    expect(result[0]!.score).toBeCloseTo(0.3 + 0.25 * IMPORTANCE_SCORES.low, 5);
  });

  it("uses 0.5 when importance is missing", () => {
    const result = ranker.rank([makeContext()], makeQuery());
    expect(result[0]!.score).toBeCloseTo(0.3 + 0.25 * MISSING_IMPORTANCE_SCORE, 5);
  });

  it("ranks critical above high above normal above low", () => {
    const contexts = [
      makeContext({ id: "low", metadata: { kind: "email", entityId: "1", importance: "low" } }),
      makeContext({ id: "critical", metadata: { kind: "email", entityId: "2", importance: "critical" } }),
      makeContext({ id: "high", metadata: { kind: "email", entityId: "3", importance: "high" } }),
      makeContext({ id: "normal", metadata: { kind: "email", entityId: "4", importance: "normal" } }),
    ];
    const result = ranker.rank(contexts, makeQuery());
    expect(result.map((c) => c.id)).toEqual(["critical", "high", "normal", "low"]);
  });
});

describe("ContextRanker source priority", () => {
  it("assigns the configured priority to every known source", () => {
    const cases: Record<string, number> = {
      memory: 0.425, // 0.2 * 1.0 + 0.225
      github: 0.405,
      gmail: 0.405,
      calendar: 0.385,
      discord: 0.365,
      telegram: 0.365,
      drive: 0.345,
    };
    for (const [source, expected] of Object.entries(cases)) {
      const result = ranker.rank([makeContext({ source })], makeQuery());
      expect(result[0]!.score).toBeCloseTo(expected, 5);
      expect(result[0]!.score).toBeCloseTo(0.2 * SOURCE_PRIORITY[source] + 0.225, 5);
    }
  });

  it("falls back to 0.5 for unknown sources", () => {
    const result = ranker.rank([makeContext({ source: "not-a-real-source" })], makeQuery());
    expect(result[0]!.score).toBeCloseTo(0.2 * UNKNOWN_SOURCE_PRIORITY + 0.225, 5);
  });
});

describe("ContextRanker intent matching", () => {
  it("boosts gmail on email keywords", () => {
    const result = ranker.rank([makeContext({ source: "gmail", metadata: { kind: "email", entityId: "1" } })], makeQuery({ query: "check my email" }));
    expect(result[0]!.score).toBeCloseTo(0.2 * INTENT_MATCH_SCORE + 0.125 + 0.2 * SOURCE_PRIORITY.gmail, 5);
  });

  it("boosts github on dev keywords", () => {
    const result = ranker.rank([makeContext({ source: "github", metadata: { kind: "issue", entityId: "1" } })], makeQuery({ query: "review this pull request" }));
    expect(result[0]!.score).toBeCloseTo(0.2 * INTENT_MATCH_SCORE + 0.125 + 0.2 * SOURCE_PRIORITY.github, 5);
  });

  it("boosts calendar on scheduling keywords", () => {
    const result = ranker.rank([makeContext({ source: "calendar", metadata: { kind: "event", entityId: "1" } })], makeQuery({ query: "schedule a meeting tomorrow" }));
    expect(result[0]!.score).toBeCloseTo(0.2 * INTENT_MATCH_SCORE + 0.125 + 0.2 * SOURCE_PRIORITY.calendar, 5);
  });

  it("boosts discord on channel keywords", () => {
    const result = ranker.rank([makeContext({ source: "discord", metadata: { kind: "message", entityId: "1" } })], makeQuery({ query: "check the channel" }));
    expect(result[0]!.score).toBeCloseTo(0.2 * INTENT_MATCH_SCORE + 0.125 + 0.2 * SOURCE_PRIORITY.discord, 5);
  });

  it("boosts telegram on chat keywords", () => {
    const result = ranker.rank([makeContext({ source: "telegram", metadata: { kind: "message", entityId: "1" } })], makeQuery({ query: "my telegram chat" }));
    expect(result[0]!.score).toBeCloseTo(0.2 * INTENT_MATCH_SCORE + 0.125 + 0.2 * SOURCE_PRIORITY.telegram, 5);
  });

  it("boosts memory on memory keywords", () => {
    const result = ranker.rank([makeContext()], makeQuery({ query: "do you remember this" }));
    expect(result[0]!.score).toBeCloseTo(0.2 * INTENT_MATCH_SCORE + 0.125 + 0.2 * SOURCE_PRIORITY.memory, 5);
  });

  it("uses the default 0.5 when no keyword matches", () => {
    const result = ranker.rank([makeContext({ source: "gmail", metadata: { kind: "email", entityId: "1" } })], makeQuery({ query: "totally unrelated" }));
    expect(result[0]!.score).toBeCloseTo(0.2 * INTENT_DEFAULT_SCORE + 0.125 + 0.2 * SOURCE_PRIORITY.gmail, 5);
  });

  it("matches keywords case-insensitively", () => {
    const upper = ranker.rank([makeContext({ source: "gmail", metadata: { kind: "email", entityId: "1" } })], makeQuery({ query: "EMAIL ALERT" }));
    const lower = ranker.rank([makeContext({ source: "gmail", metadata: { kind: "email", entityId: "1" } })], makeQuery({ query: "email alert" }));
    expect(upper[0]!.score).toBeCloseTo(lower[0]!.score, 10);
  });

  it("matches multi-word keywords as a phrase", () => {
    const result = ranker.rank([makeContext({ source: "github", metadata: { kind: "pr", entityId: "1" } })], makeQuery({ query: "the pull request is ready" }));
    expect(result[0]!.score).toBeCloseTo(0.2 * INTENT_MATCH_SCORE + 0.125 + 0.2 * SOURCE_PRIORITY.github, 5);
  });

  it("boosts only the source matching the query", () => {
    const gmail = makeContext({ id: "g", source: "gmail", metadata: { kind: "email", entityId: "1" } });
    const github = makeContext({ id: "gh", source: "github", metadata: { kind: "issue", entityId: "2" } });
    const result = ranker.rank([github, gmail], makeQuery({ query: "new email" }));
    expect(result[0]!.id).toBe("g");
    expect(result[0]!.score).toBeGreaterThan(result[1]!.score);
  });
});

describe("ContextRanker normalization, clamping, immutability", () => {
  it("keeps every score within [0, 1] for mixed inputs", () => {
    const contexts = [
      makeContext({ source: "unknown-source", timestamp: null }),
      makeContext({ source: "memory", timestamp: NOW.toISOString(), metadata: { kind: "memory", entityId: "1", importance: "critical" } }),
      makeContext({ source: "drive", timestamp: new Date(NOW.getTime() - 5 * RECENCY_HALF_LIFE_MS).toISOString() }),
    ];
    const result = ranker.rank(contexts, makeQuery({ query: "remember email" }));
    for (const item of result) {
      expect(item.score).toBeGreaterThanOrEqual(0);
      expect(item.score).toBeLessThanOrEqual(1);
    }
  });

  it("clamps the maximum achievable score to 1", () => {
    const best = makeContext({
      source: "memory",
      timestamp: NOW.toISOString(),
      metadata: { kind: "memory", entityId: "1", importance: "critical" },
    });
    const result = ranker.rank([best], makeQuery({ query: "memory remember" }));
    expect(result[0]!.score).toBeCloseTo(1, 5);
  });

  it("never returns a negative score", () => {
    const worst = makeContext({ source: "unknown", timestamp: null, metadata: { kind: "memory", entityId: "1", importance: "low" } });
    const result = ranker.rank([worst], makeQuery());
    expect(result[0]!.score).toBeGreaterThanOrEqual(0);
  });

  it("does not mutate the input array order", () => {
    const older = makeContext({ id: "older", timestamp: new Date(NOW.getTime() - RECENCY_HALF_LIFE_MS).toISOString() });
    const newer = makeContext({ id: "newer", timestamp: NOW.toISOString() });
    const input = [older, newer];
    ranker.rank(input, makeQuery());
    expect(input.map((c) => c.id)).toEqual(["older", "newer"]);
  });

  it("does not mutate context objects (no score added in place)", () => {
    const context = makeContext({ id: "c1" });
    ranker.rank([context], makeQuery());
    expect(context).not.toHaveProperty("score");
    expect(context.content).toBe("Content");
  });

  it("returns brand-new objects", () => {
    const context = makeContext();
    const result = ranker.rank([context], makeQuery());
    expect(result[0]).not.toBe(context);
  });

  it("is deterministic for identical inputs", () => {
    const contexts = [
      makeContext({ id: "a", source: "gmail", timestamp: NOW.toISOString(), metadata: { kind: "email", entityId: "1", importance: "high" } }),
      makeContext({ id: "b", source: "calendar", timestamp: null, metadata: { kind: "event", entityId: "2" } }),
      makeContext({ id: "c", source: "github", timestamp: new Date(NOW.getTime() - RECENCY_HALF_LIFE_MS).toISOString() }),
    ];
    const query = makeQuery({ query: "email update" });
    const first = ranker.rank(contexts, query);
    const second = ranker.rank(contexts, query);
    expect(first.map((c) => c.id)).toEqual(second.map((c) => c.id));
    expect(first.map((c) => c.score)).toEqual(second.map((c) => c.score));
  });
});
