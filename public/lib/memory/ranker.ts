/**
 * Memory Engine — memory ranker (deterministic scoring).
 *
 * Combines the semantic score (`./semanticSearch`) with the remaining
 * ranking signals into a single score in [0, 1] and returns memories sorted
 * descending (stable).
 *
 * Signals and weights:
 * - semantic 0.30 — textual overlap (content/title/tags/metadata)
 * - importance 0.20 — reuses the Context Engine's `IMPORTANCE_SCORES`
 * - freshness 0.15 — recency of `updatedAt` relative to the newest memory
 * - accessFrequency 0.10 — `accessCount` normalized
 * - recency 0.10 — recency of `lastAccessedAt` relative to the most recently
 *   accessed memory (null → 0)
 * - tokenScore 0.05 — compactness (1 − tokens/normalizer, floored at 0)
 * - kind 0.05 — `MEMORY_KIND_WEIGHTS`
 * - source 0.05 — `MEMORY_SOURCE_WEIGHTS`
 *
 * Freshness/recency are computed relative to the ranked set (no clock), so
 * ranking is fully deterministic. A conversation-relevance boost
 * (`CONVERSATION_RELEVANCE_BOOST`) is added when the optional
 * `conversationId` matches the memory's link.
 */

import { IMPORTANCE_SCORES, MISSING_IMPORTANCE_SCORE, RECENCY_HALF_LIFE_MS } from "@/lib/context/contextRanker";
import { estimateMemoryTokens, type Memory, type MemoryKind, type MemorySearchResult, type MemorySource } from "./types";
import { semanticScoreOf } from "./semanticSearch";

/** Ranker signal weights (sum to 1). */
export const MEMORY_RANKING_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  semantic: 0.3,
  importance: 0.2,
  freshness: 0.15,
  accessFrequency: 0.1,
  recency: 0.1,
  tokenScore: 0.05,
  kind: 0.05,
  source: 0.05,
});

/** Relative weight of each memory kind. */
export const MEMORY_KIND_WEIGHTS: Readonly<Record<MemoryKind, number>> = Object.freeze({
  fact: 1,
  preference: 1,
  task: 0.9,
  knowledge: 0.9,
  conversation: 0.8,
  context: 0.7,
});

/** Relative weight of each memory source. */
export const MEMORY_SOURCE_WEIGHTS: Readonly<Record<MemorySource, number>> = Object.freeze({
  user: 1,
  assistant: 0.9,
  system: 1,
  tool: 0.8,
  derived: 0.8,
});

/** Access count that yields a full access-frequency signal. */
export const MEMORY_ACCESS_NORMALIZER = 10;

/** Token estimate that yields a zero token-score signal. */
export const MEMORY_TOKEN_SCORE_NORMALIZER = 200;

/** Score boost for memories linked to the queried conversation. */
export const CONVERSATION_RELEVANCE_BOOST = 0.05;

/** Options accepted by {@link rankMemories}. */
export interface RankOptions {
  /**
   * When provided, memories linked to this conversation receive
   * `CONVERSATION_RELEVANCE_BOOST` (deterministic preference, not a filter).
   */
  readonly conversationId?: string;
}

/** Clamp a value into [0, 1]. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Milliseconds for a timestamp, or `-Infinity` when null/unparseable. */
function millis(timestamp: string | null): number {
  if (timestamp === null) return Number.NEGATIVE_INFINITY;
  const time = Date.parse(timestamp);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** Maximum timestamp of a set, or `-Infinity` when every value is unknown. */
function maxMillis(values: number[]): number {
  return values.reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);
}

/**
 * Exponential decay relative to `referenceMs` (the newest value in the set):
 * `2^(-age / halfLife)`. Unknown/null values score 0; a reference of
 * `-Infinity` (no parseable values) scores 0 for every item.
 */
function decay(timestampMs: number, referenceMs: number, halfLifeMs: number): number {
  if (timestampMs === Number.NEGATIVE_INFINITY || referenceMs === Number.NEGATIVE_INFINITY) {
    return 0;
  }
  const age = Math.max(0, referenceMs - timestampMs);
  return Math.pow(2, -age / halfLifeMs);
}

/**
 * Rank `memories` by the weighted combination of all signals and return them
 * sorted descending (stable — ties keep input order).
 *
 * - The input array and its objects are never mutated; each result is a new
 *   top-level object (`{ ...memory, score }`).
 * - An empty query still ranks (semantic signal is 0 for every item; the
 *   remaining signals dominate).
 * - Deterministic: identical inputs (including equal timestamps and ties)
 *   produce identical orderings.
 */
export function rankMemories(
  memories: readonly Memory[],
  query: string,
  options: RankOptions = {},
): MemorySearchResult[] {
  const maxUpdated = maxMillis(memories.map((memory) => millis(memory.metadata.updatedAt)));
  const maxAccessed = maxMillis(
    memories.map((memory) => millis(memory.metadata.lastAccessedAt)),
  );

  const scored: MemorySearchResult[] = memories.map((memory) => {
    const semantic = semanticScoreOf(memory, query);
    const importance =
      IMPORTANCE_SCORES[memory.metadata.importance] ?? MISSING_IMPORTANCE_SCORE;
    const freshness = decay(millis(memory.metadata.updatedAt), maxUpdated, RECENCY_HALF_LIFE_MS);
    const recency = decay(millis(memory.metadata.lastAccessedAt), maxAccessed, RECENCY_HALF_LIFE_MS);
    const accessFrequency = Math.min(1, memory.metadata.accessCount / MEMORY_ACCESS_NORMALIZER);
    const tokenScore = 1 - Math.min(1, estimateMemoryTokens(memory) / MEMORY_TOKEN_SCORE_NORMALIZER);
    const kind = MEMORY_KIND_WEIGHTS[memory.metadata.kind] ?? 0.5;
    const source = MEMORY_SOURCE_WEIGHTS[memory.metadata.source] ?? 0.5;

    const w = MEMORY_RANKING_WEIGHTS;
    const base =
      w.semantic * semantic +
      w.importance * importance +
      w.freshness * freshness +
      w.accessFrequency * accessFrequency +
      w.recency * recency +
      w.tokenScore * tokenScore +
      w.kind * kind +
      w.source * source;

    const conversationBoost =
      options.conversationId !== undefined &&
      memory.metadata.conversationId === options.conversationId
        ? CONVERSATION_RELEVANCE_BOOST
        : 0;

    return { ...memory, score: clamp01(base + conversationBoost) };
  });

  return scored.sort((a, b) => b.score - a.score);
}
