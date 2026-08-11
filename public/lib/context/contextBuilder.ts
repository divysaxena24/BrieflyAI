/**
 * Context Engine — retrieval orchestration.
 *
 * Runs the retrieve stage of the context pipeline: filters to available
 * sources, orders them by priority, retrieves from all of them concurrently,
 * and flattens the successful results into a single ordered list.
 *
 * No ranking, deduplication, compression, or token-budget allocation happens
 * here — this module is orchestration only.
 *
 * Integration: the constructor accepts the `readonly ContextSource[]` list
 * produced by `ContextSourceRegistry.getSources()`, so the builder can be
 * wired directly to registry-configured sources.
 */

import type { Context, ContextSource, RetrievalQuery } from "./types";
import { sortByPriority } from "./sources/contextSource";

/**
 * Orchestrates parallel context retrieval across a set of sources.
 *
 * The source list is snapshotted at construction time: later mutations of the
 * caller's array do not affect the builder, and `build()` never mutates it.
 */
export class ContextBuilder {
  private readonly sources: ContextSource[];

  constructor(sources: readonly ContextSource[]) {
    this.sources = [...sources];
  }

  /**
   * Retrieve context for a query.
   *
   * Workflow:
   * 1. Resolve each source's `isAvailable(userId)` (called exactly once per
   *    source); a source whose `isAvailable` throws is treated as
   *    unavailable and skipped.
   * 2. Sort the available sources by descending priority
   *    (`sortByPriority` — highest first, stable for equal priorities).
   * 3. Call `retrieve(query)` on every source concurrently via
   *    `Promise.allSettled`, so a failing source never fails the build.
   * 4. Collect only the fulfilled `Context[]` results; ignore rejections.
   * 5. Flatten the successful arrays into a single list.
   *
   * Result ordering: contexts from higher-priority sources come first; within
   * each source, retrieval order is preserved. Empty sources contribute
   * nothing. Returns `[]` when no source yields contexts.
   *
   * The query, the source list, and the source objects are never mutated.
   */
  async build(query: RetrievalQuery): Promise<Context[]> {
    const available = await this.resolveAvailableSources(query.userId);
    const ordered = sortByPriority(available);

    const results = await Promise.allSettled(
      ordered.map((source) => source.retrieve(query)),
    );

    return results.flatMap((result) =>
      result.status === "fulfilled" && Array.isArray(result.value) ? result.value : [],
    );
  }

  /**
   * Resolve which sources are available for `userId`, tolerating a source
   * whose `isAvailable` throws (treated as unavailable and skipped).
   * Every source's `isAvailable` is called exactly once; original order is
   * preserved.
   */
  private async resolveAvailableSources(userId: string): Promise<ContextSource[]> {
    // Promise.allSettled already captures a rejecting isAvailable as a
    // `rejected` result, which the filter below drops (source skipped).
    const settled = await Promise.allSettled(
      this.sources.map((source) =>
        source.isAvailable(userId).then((available) => (available ? source : null)),
      ),
    );

    return settled.flatMap((result) =>
      result.status === "fulfilled" && result.value !== null ? [result.value] : [],
    );
  }
}

export default ContextBuilder;
