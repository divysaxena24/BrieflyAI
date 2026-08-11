/**
 * Context Engine — duplicate removal.
 *
 * Two deterministic stages:
 *   1. Exact-key deduplication by `context.id`.
 *   2. Thread collapsing for contexts sharing `source + metadata.threadId`.
 *
 * No fuzzy similarity, no SimHash/MinHash, no embeddings, no semantic
 * comparison — those belong to a later phase.
 */

import type { RankedContext } from "./types";

/**
 * Milliseconds since epoch for a timestamp, or `-Infinity` for null,
 * unparseable, or otherwise unknown timestamps (so they lose recency ties).
 */
function timestampMillis(timestamp: string | null): number {
  if (timestamp === null) return Number.NEGATIVE_INFINITY;
  const time = Date.parse(timestamp);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/**
 * Pure heuristic deduplicator.
 */
export class ContextDeduplicator {
  constructor() {}

  /**
   * Remove duplicate contexts and collapse threads.
   *
   * Stage 1 (exact key): contexts sharing the same `id` are reduced to a
   * single item — the highest score wins; on equal scores the first item wins.
   *
   * Stage 2 (thread collapse): contexts with the same `source` and a present
   * `metadata.threadId` are grouped; each group is reduced to one item — the
   * highest score wins, then the newest timestamp, then the first item.
   *
   * The result is sorted by score descending (stable for equal scores). The
   * input array and its objects are never mutated; each returned item is a
   * new top-level object (nested `metadata`/`permissions` references are
   * shared with the input but never modified).
   */
  deduplicate(contexts: RankedContext[]): RankedContext[] {
    const exactDeduped = this.exactDeduplicate(contexts);
    const threadCollapsed = this.collapseThreads(exactDeduped);

    return threadCollapsed
      .map((context) => ({ ...context }))
      .sort((a, b) => b.score - a.score);
  }

  /** Stage 1 — exact-key deduplication by `context.id`. */
  private exactDeduplicate(contexts: RankedContext[]): RankedContext[] {
    const bestById = new Map<string, RankedContext>();
    for (const context of contexts) {
      const existing = bestById.get(context.id);
      // Replace only when strictly higher scoring; ties keep the first item.
      if (existing === undefined || context.score > existing.score) {
        bestById.set(context.id, context);
      }
    }
    return [...bestById.values()];
  }

  /** Stage 2 — collapse each `source + threadId` group to one item. */
  private collapseThreads(contexts: RankedContext[]): RankedContext[] {
    const standalone: RankedContext[] = [];
    const threads = new Map<string, RankedContext[]>();

    for (const context of contexts) {
      const threadId = context.metadata.threadId;
      if (threadId == null) {
        standalone.push(context);
        continue;
      }
      const key = `${context.source}\u0000${threadId}`;
      const group = threads.get(key);
      if (group) {
        group.push(context);
      } else {
        threads.set(key, [context]);
      }
    }

    const representatives: RankedContext[] = [];
    for (const group of threads.values()) {
      representatives.push(this.pickThreadRepresentative(group));
    }

    return [...standalone, ...representatives];
  }

  /**
   * Select the single representative of a thread group: highest score wins,
   * then newest timestamp, then the first item (on complete ties).
   */
  private pickThreadRepresentative(group: RankedContext[]): RankedContext {
    return group.reduce((best, current) => {
      if (current.score > best.score) return current;
      if (current.score < best.score) return best;
      if (timestampMillis(current.timestamp) > timestampMillis(best.timestamp)) {
        return current;
      }
      return best;
    });
  }
}

export default ContextDeduplicator;
