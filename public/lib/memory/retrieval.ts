/**
 * Memory Engine — pure retrieval engine.
 *
 * Deterministic, structural retrieval over a `MemoryRepository`. No AI, no
 * embeddings, no scoring — filtering and ordering only. (Scored retrieval
 * lives in `./semanticSearch` and `./ranker`.)
 *
 * All results are detached clones, ordered deterministically (equal
 * `updatedAt` values tie-break by ascending id).
 */

import { MemoryRepository } from "./repository";
import type { Memory, MemoryImportance, MemoryKind, MemorySource } from "./types";

/**
 * A bounded window of the most recent memories (by `updatedAt`, newest
 * first). `total` is the repository size and `trimmed` is how many memories
 * were cut from the window.
 */
export interface MemoryWindow {
  /** The windowed memories, newest first. */
  readonly memories: readonly Memory[];
  /** Number of memories in the repository. */
  readonly total: number;
  /** Number of memories cut from the window. */
  readonly trimmed: number;
}

/**
 * Deterministic descending sort by `updatedAt` (newest first), tie-broken by
 * ascending id. Pure — the input array is not modified.
 */
export function sortMemoriesNewestFirst(memories: readonly Memory[]): Memory[] {
  return [...memories].sort((a, b) => {
    const byTime = Date.parse(b.metadata.updatedAt) - Date.parse(a.metadata.updatedAt);
    if (byTime !== 0) return byTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Lowercased, whitespace-split tokens of a query. */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * Pure read-side retrieval over a repository's memories.
 *
 * The repository is captured at construction time; because repositories are
 * immutable, a retriever is always consistent with the exact repository it
 * was built from.
 */
export class MemoryRetriever {
  private readonly repository: MemoryRepository;

  constructor(repository: MemoryRepository) {
    this.repository = repository;
  }

  /**
   * Return memories whose title/content contain any query token (case-
   * insensitive substring) or whose tags match any query token exactly
   * (case-insensitive). Insertion order is preserved; `limit` caps the
   * result. An empty query yields `[]`.
   */
  retrieveByQuery(query: string, options: { limit?: number } = {}): Memory[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];

    const matches = this.repository
      .list()
      .filter((memory) => this.matchesAnyToken(memory, tokens));

    return options.limit === undefined ? matches : matches.slice(0, options.limit);
  }

  /** Return the `count` most recent memories (by `updatedAt`, newest first). */
  retrieveRecent(count: number): Memory[] {
    if (count <= 0) return [];
    return sortMemoriesNewestFirst(this.repository.list()).slice(0, count);
  }

  /** Return every memory with the given importance, in insertion order. */
  retrieveImportant(importance: MemoryImportance): Memory[] {
    return this.repository.findByImportance(importance);
  }

  /**
   * Return memories whose tags match the given tags. `match: "any"` requires
   * at least one shared tag; `match: "all"` requires every given tag.
   */
  retrieveByTags(tags: readonly string[], match: "any" | "all" = "any"): Memory[] {
    if (tags.length === 0) return [];
    return this.repository.list().filter((memory) => {
      if (match === "all") {
        return tags.every((tag) => memory.metadata.tags.includes(tag));
      }
      return tags.some((tag) => memory.metadata.tags.includes(tag));
    });
  }

  /** Return memories whose kind is one of `kinds`, in insertion order. */
  retrieveByKinds(kinds: readonly MemoryKind[]): Memory[] {
    if (kinds.length === 0) return [];
    return this.repository
      .list()
      .filter((memory) => kinds.includes(memory.metadata.kind));
  }

  /** Return memories whose source is one of `sources`, in insertion order. */
  retrieveBySource(sources: readonly MemorySource[]): Memory[] {
    if (sources.length === 0) return [];
    return this.repository
      .list()
      .filter((memory) => sources.includes(memory.metadata.source));
  }

  /** Return memories linked to a conversation, in insertion order. */
  retrieveByConversation(conversationId: string): Memory[] {
    return this.repository
      .list()
      .filter((memory) => memory.metadata.conversationId === conversationId);
  }

  /**
   * Return a bounded window of the `limit` most recent memories (by
   * `updatedAt`, newest first). A non-positive `limit` yields an empty window
   * with `trimmed === total`.
   */
  retrieveWindow(limit: number): MemoryWindow {
    const total = this.repository.count();
    if (limit <= 0) {
      return { memories: [], total, trimmed: total };
    }
    const sorted = sortMemoriesNewestFirst(this.repository.list());
    const memories = sorted.slice(0, limit);
    return { memories, total, trimmed: total - memories.length };
  }

  /** Whether any query token matches the memory's title/content/tags. */
  private matchesAnyToken(memory: Memory, tokens: string[]): boolean {
    const haystack = `${memory.metadata.title} ${memory.content}`.toLowerCase();
    const tags = memory.metadata.tags.map((tag) => tag.toLowerCase());
    return tokens.some(
      (token) => haystack.includes(token) || tags.includes(token),
    );
  }
}
