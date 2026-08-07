/**
 * Context Engine — reusable ContextSource infrastructure.
 *
 * Defines the abstract base class every context provider extends, plus pure
 * helpers for sorting and filtering source collections. No retrieval logic
 * lives here.
 */

import type { Context, ContextSource, RetrievalQuery } from "@/lib/context/types";

/**
 * Abstract base implementation of the `ContextSource` contract.
 *
 * Subclasses supply an id and priority via the constructor and implement
 * `retrieve()`. `isAvailable()` defaults to true and may be overridden.
 */
export abstract class ContextSourceBase implements ContextSource {
  /** Unique source id (e.g. "gmail", "github", "memory"). */
  readonly id: string;
  /** Default ranking weight of this source relative to others. */
  readonly priority: number;

  constructor(id: string, priority: number) {
    this.id = id;
    this.priority = priority;
  }

  /**
   * Whether the source can serve context for a user right now.
   * Defaults to true; override in subclasses that depend on a connection.
   */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * Retrieve candidate context items for a query. Implemented by subclasses.
   */
  abstract retrieve(query: RetrievalQuery): Promise<Context[]>;
}

/**
 * Return the sources sorted by descending priority (highest first).
 * Pure — the input array is not modified.
 */
export function sortByPriority(sources: ContextSource[]): ContextSource[] {
  return [...sources].sort((a, b) => b.priority - a.priority);
}

/**
 * Return only the sources that are available for the given user, preserving
 * their original order. Availability checks run concurrently.
 */
export async function filterAvailableSources(
  sources: ContextSource[],
  userId: string,
): Promise<ContextSource[]> {
  const availability = await Promise.all(
    sources.map((source) => source.isAvailable(userId)),
  );
  return sources.filter((_, index) => availability[index]);
}
