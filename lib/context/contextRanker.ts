/**
 * Context Engine — heuristic relevance ranking.
 *
 * Scores every context in [0, 1] using four deterministic signals — recency,
 * importance, source priority, and intent matching — then returns the ranked
 * list, highest score first.
 *
 * No embeddings, no vector search, no AI, no external services.
 */

import type { Context, RankedContext, RetrievalQuery } from "./types";

/** Half-life of the recency decay: 24 hours. */
export const RECENCY_HALF_LIFE_MS = 24 * 60 * 60 * 1000;

/** Default weights of the four ranking signals (sum to 1). */
export const RANKING_WEIGHTS: Readonly<{
  recency: number;
  importance: number;
  sourcePriority: number;
  intent: number;
}> = Object.freeze({
  recency: 0.35,
  importance: 0.25,
  sourcePriority: 0.2,
  intent: 0.2,
});

/** Score per `metadata.importance` value. */
export const IMPORTANCE_SCORES: Readonly<Record<string, number>> = Object.freeze({
  critical: 1,
  high: 0.8,
  normal: 0.5,
  low: 0.2,
});

/** Score used when `metadata.importance` is missing. */
export const MISSING_IMPORTANCE_SCORE = 0.5;

/** Default source priority per platform id. */
export const SOURCE_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  memory: 1,
  github: 0.9,
  gmail: 0.9,
  calendar: 0.8,
  discord: 0.7,
  telegram: 0.7,
  whatsapp: 0.7,
  drive: 0.6,
});

/** Score used for source ids not present in `SOURCE_PRIORITY`. */
export const UNKNOWN_SOURCE_PRIORITY = 0.5;

/** Intent keywords per source id (matched case-insensitively). */
export const INTENT_KEYWORDS: Readonly<Record<string, string[]>> = Object.freeze({
  gmail: ["email", "mail", "gmail"],
  calendar: ["meeting", "calendar", "schedule", "tomorrow"],
  github: ["repo", "github", "commit", "pull request", "issue"],
  discord: ["discord", "channel"],
  telegram: ["telegram", "chat"],
  whatsapp: ["whatsapp", "message"],
  memory: ["memory", "remember"],
});

/** Intent score when the query matches the context's source. */
export const INTENT_MATCH_SCORE = 1;

/** Intent score when the query does not match the context's source. */
export const INTENT_DEFAULT_SCORE = 0.5;

/**
 * Exponential recency decay: `2^(-age / halfLife)`.
 * Recent items score ≈ 1; items at exactly one half-life (24h) score 0.5;
 * very old items approach 0. Null or unparseable timestamps score 0.
 */
function recencyScore(timestamp: string | null, now: number): number {
  if (timestamp === null) return 0;
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return 0;
  const age = Math.max(0, now - time);
  return Math.pow(2, -age / RECENCY_HALF_LIFE_MS);
}

/** Importance signal: maps `metadata.importance` to a score. */
function importanceScore(importance: Context["metadata"]["importance"]): number {
  if (importance === undefined) return MISSING_IMPORTANCE_SCORE;
  return IMPORTANCE_SCORES[importance];
}

/** Source priority signal: falls back to the unknown-source score. */
function sourcePriorityScore(source: string): number {
  return SOURCE_PRIORITY[source] ?? UNKNOWN_SOURCE_PRIORITY;
}

/**
 * Intent signal: 1 when the lowercased query contains a keyword for the
 * context's source, otherwise the default 0.5.
 */
function intentScore(source: string, lowerQuery: string): number {
  const keywords = INTENT_KEYWORDS[source];
  if (!keywords) return INTENT_DEFAULT_SCORE;
  const matched = keywords.some((keyword) => lowerQuery.includes(keyword));
  return matched ? INTENT_MATCH_SCORE : INTENT_DEFAULT_SCORE;
}

/** Clamp a value into [0, 1]. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Weighted sum of the four signals, clamped to [0, 1]. */
function scoreOf(
  context: Context,
  lowerQuery: string,
  now: number,
): number {
  const { recency, importance, sourcePriority, intent } = RANKING_WEIGHTS;
  return clamp01(
    recency * recencyScore(context.timestamp, now) +
      importance * importanceScore(context.metadata.importance) +
      sourcePriority * sourcePriorityScore(context.source) +
      intent * intentScore(context.source, lowerQuery),
  );
}

/**
 * Pure heuristic ranker over the four signals defined above.
 */
export class ContextRanker {
  constructor() {}

  /**
   * Score every context and return them sorted by descending score.
   *
   * - Each returned item is a new object: `{ ...context, score }`.
   * - Sorting is stable: contexts with equal scores keep their input order.
   * - The input array and its contexts are never mutated.
   */
  rank(contexts: Context[], query: RetrievalQuery): RankedContext[] {
    const now = Date.now();
    const lowerQuery = query.query.toLowerCase();
    const ranked = contexts.map((context) => ({
      ...context,
      score: scoreOf(context, lowerQuery, now),
    }));
    return ranked.sort((a, b) => b.score - a.score);
  }
}

export default ContextRanker;
