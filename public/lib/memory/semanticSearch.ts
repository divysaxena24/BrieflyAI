/**
 * Memory Engine — semantic memory search (deterministic).
 *
 * Scores memories by textual overlap with a query — NO vector databases, NO
 * external embedding APIs, NO AI. The semantic score is a weighted blend of
 * token-overlap fractions across four fields:
 *
 * - content overlap (0.4)
 * - title overlap (0.3)
 * - tag overlap (0.2)
 * - metadata overlap (0.1) — `conversationId` + `extra` values
 *
 * `searchMemories` returns memories sorted by semantic score (descending,
 * stable). The full ranker (`./ranker`) combines this semantic score with the
 * other ranking signals.
 */

import type { Memory, MemorySearchResult } from "./types";

/** Semantic signal weights (sum to 1). */
export const SEMANTIC_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  content: 0.4,
  title: 0.3,
  tags: 0.2,
  metadata: 0.1,
});

/** Options accepted by {@link searchMemories}. */
export interface SemanticSearchOptions {
  /**
   * When true, only memories that match EVERY query token (across all
   * fields) are returned; when false (default), any-token matches are kept.
   */
  readonly requireAll?: boolean;
}

/** Lowercased, whitespace-split query tokens. Empty queries yield `[]`. */
export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** Whether a single token appears in the memory's content, title, or metadata. */
function tokenInText(memory: Memory, token: string): boolean {
  const text = `${memory.metadata.title} ${memory.content} ${metadataText(memory)}`.toLowerCase();
  return text.includes(token);
}

/** Whether a token exactly matches any tag (case-insensitive). */
function tokenInTags(memory: Memory, token: string): boolean {
  return memory.metadata.tags.some((tag) => tag.toLowerCase() === token);
}

/** Lowercased stringified metadata used for the metadata-overlap signal. */
function metadataText(memory: Memory): string {
  const parts: string[] = [];
  if (memory.metadata.conversationId !== undefined) parts.push(memory.metadata.conversationId);
  if (memory.extra !== undefined) {
    for (const value of Object.values(memory.extra)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        parts.push(String(value));
      }
    }
  }
  return parts.join(" ");
}

/** Fraction of `tokens` present in `haystack` (case-insensitive substring). */
function overlapFraction(tokens: string[], haystack: string): number {
  if (tokens.length === 0) return 0;
  const lower = haystack.toLowerCase();
  return tokens.filter((token) => lower.includes(token)).length / tokens.length;
}

/**
 * Compute the semantic score of a memory against a query in [0, 1].
 *
 * The score is the weighted blend of content/title/tag/metadata overlap. An
 * empty query scores 0. Deterministic and pure.
 */
export function semanticScoreOf(memory: Memory, query: string): number {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return 0;

  const content = overlapFraction(tokens, memory.content);
  const title = overlapFraction(tokens, memory.metadata.title);
  const tags =
    tokens.filter((token) => tokenInTags(memory, token)).length / tokens.length;
  const metadata = overlapFraction(tokens, metadataText(memory));

  return (
    SEMANTIC_WEIGHTS.content * content +
    SEMANTIC_WEIGHTS.title * title +
    SEMANTIC_WEIGHTS.tags * tags +
    SEMANTIC_WEIGHTS.metadata * metadata
  );
}

/**
 * Search `memories` by semantic score and return them sorted descending
 * (stable — ties keep input order).
 *
 * - Default (`requireAll: false`): only memories with a positive semantic
 *   score are returned (at least one token matched somewhere).
 * - `requireAll: true`: only memories matching EVERY token (across all
 *   fields) are returned.
 * - The input array and its objects are never mutated; each result is a new
 *   top-level object (`{ ...memory, score }`).
 */
export function searchMemories(
  memories: readonly Memory[],
  query: string,
  options: SemanticSearchOptions = {},
): MemorySearchResult[] {
  const tokens = tokenizeQuery(query);
  const scored: MemorySearchResult[] = [];
  for (const memory of memories) {
    const score = semanticScoreOf(memory, query);
    if (options.requireAll === true) {
      const matchesEveryToken =
        tokens.length > 0 && tokens.every((token) => tokenInText(memory, token) || tokenInTags(memory, token));
      if (!matchesEveryToken) continue;
    } else if (score <= 0) {
      continue;
    }
    scored.push({ ...memory, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}
