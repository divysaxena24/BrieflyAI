/**
 * Context Engine — deterministic compression.
 *
 * Fits ranked contexts into a token budget using truncation only — no AI
 * summarization, no semantic compression. Items are processed in their
 * existing order; the first item that does not fit is truncated to the
 * remaining budget and processing stops.
 */

import type { CompressionResult, Context, RankedContext } from "./types";

/** Marker appended to truncated content. */
export const TRUNCATION_MARKER = "...[truncated]...";

/**
 * Truncate content to at most `maxCharacters` code points (unicode-safe) and
 * append the truncation marker.
 */
function truncateContent(content: string, maxCharacters: number): string {
  const kept = Array.from(content).slice(0, maxCharacters).join("");
  return `${kept}${TRUNCATION_MARKER}`;
}

/**
 * Pure deterministic compressor.
 */
export class ContextCompressor {
  constructor() {}

  /**
   * Fit contexts into `budget` tokens.
   *
   * - Items are processed in their existing order and never reordered.
   * - An item whose `tokenEstimate` fits the remaining budget is kept
   *   unchanged (as a new object) and the remaining budget is reduced.
   * - The first item that exceeds the remaining budget is truncated:
   *   `estimatedCharacters = allowedTokens * 4` code points are kept, the
   *   truncation marker is appended, `truncated`/`compressed` are set, its
   *   `tokenEstimate` becomes the remaining budget, and `originalTokens`
   *   records the previous estimate. The budget then reaches zero and
   *   processing stops — later contexts are ignored.
 * - A non-positive budget yields an empty result; `remainingTokens` mirrors
 *   the passed budget (it may be negative, and `usedTokens` is 0).
 * - The marker is always appended when an item is truncated, even when the
 *   content is short enough that no characters were actually removed, and the
 *   marker's own token cost is not reflected in `tokenEstimate` (which is set
 *   to the allowed budget per spec).
 *
 * Note: the `estimatedCharacters = allowedTokens * 4` rule is the inverse of
 * the `estimateTokens` heuristic (ceil(length / 4)) in `lib/context/tokenBudget.ts`;
 * keep the two consistent if either changes.
 *
 * The input array and its objects are never mutated; every returned item is
 * a new top-level object (nested `metadata`/`permissions` references are
 * shared but never modified).
 */
  compress(contexts: RankedContext[], budget: number): CompressionResult {
    if (budget <= 0) {
      return { contexts: [], usedTokens: 0, remainingTokens: budget };
    }

    let remaining = budget;
    const result: Context[] = [];

    for (const context of contexts) {
      if (remaining <= 0) break;

      if (context.tokenEstimate <= remaining) {
        result.push({ ...context });
        remaining -= context.tokenEstimate;
        continue;
      }

      const allowedTokens = remaining;
      const estimatedCharacters = allowedTokens * 4;
      result.push({
        ...context,
        content: truncateContent(context.content, estimatedCharacters),
        tokenEstimate: allowedTokens,
        originalTokens: context.tokenEstimate,
        truncated: true,
        compressed: true,
      });
      remaining = 0;
      break;
    }

    return {
      contexts: result,
      usedTokens: budget - remaining,
      remainingTokens: remaining,
    };
  }
}

export default ContextCompressor;
