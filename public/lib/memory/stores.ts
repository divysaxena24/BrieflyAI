/**
 * Memory Engine — short-term & long-term memory stores.
 *
 * A `MemoryStore` is a tier-scoped, immutable facade over a `MemoryRepository`:
 *
 * - **short-term** — recent conversation context, temporary context, high
 *   churn (default tier for new memories).
 * - **long-term** — persistent knowledge, preferences, facts, tasks.
 *
 * `promote`/`demote` move memories between tiers (a tier field change on the
 * shared repository); `merge` combines memories into one; `prune` removes
 * expired (and optionally archived) memories; `trim` caps the store to the
 * most recent memories. Every mutation returns a successor store — the
 * receiver is never changed. No database, no background jobs — pruning and
 * trimming are explicit, deterministic operations.
 */

import { AppError } from "@/lib/errors";
import { MemoryNotFoundError, MemoryRepository, type MemoryPatch } from "./repository";
import { sortMemoriesNewestFirst } from "./retrieval";
import {
  createMemory,
  isExpired,
  type CreateMemoryInput,
  type Memory,
  type MemoryImportance,
  type MemoryTier,
} from "./types";

/** Raised when {@link MemoryStore.merge} is called with fewer than two ids. */
export class MemoryMergeError extends AppError {
  constructor() {
    super("Memory merge requires at least two memories", 400, "memory_merge_error");
  }
}

/** Importance ordering used to pick the merged memory's importance. */
const IMPORTANCE_RANK: Readonly<Record<MemoryImportance, number>> = Object.freeze({
  low: 1,
  normal: 2,
  high: 3,
  critical: 4,
});

/** Deterministic ascending id sort (stable merged output regardless of input order). */
function sortById(memories: readonly Memory[]): Memory[] {
  return [...memories].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Immutable tier-scoped memory store.
 *
 * Reads are scoped to the store's tier; mutations return successor stores
 * over the successor repository (both tiers are kept in the same repository,
 * distinguished by the `tier` field).
 */
export class MemoryStore {
  /** The backing immutable repository. */
  readonly repository: MemoryRepository;
  /** The tier this store manages. */
  readonly tier: MemoryTier;

  constructor(repository: MemoryRepository, tier: MemoryTier) {
    this.repository = repository;
    this.tier = tier;
  }

  /** Return detached clones of this tier's memories, in insertion order. */
  list(): Memory[] {
    return this.tiered();
  }

  /** Number of this tier's memories. */
  count(): number {
    return this.tiered().length;
  }

  /** Return a detached clone of a tier memory, or `undefined`. */
  find(id: string): Memory | undefined {
    const memory = this.repository.find(id);
    return memory !== undefined && memory.metadata.tier === this.tier ? memory : undefined;
  }

  /** Whether a memory of this tier with the given id is stored. */
  has(id: string): boolean {
    return this.find(id) !== undefined;
  }

  /**
   * Store a new memory in THIS tier (the input's tier is overridden) and
   * return it plus the successor store. Throws `MemoryDuplicateError` for an
   * already-stored id.
   */
  add(input: CreateMemoryInput): { store: MemoryStore; memory: Memory } {
    const memory = createMemory({ ...input, tier: this.tier });
    const { memory: stored, repository } = this.repository.add(memory);
    return { store: new MemoryStore(repository, this.tier), memory: stored };
  }

  /**
   * Move a memory to the long-term tier (idempotent for long-term memories).
   * When `at` is provided, `updatedAt` becomes `at`. Returns the moved memory
   * plus the successor store. Throws `MemoryNotFoundError` for unknown or
   * other-tier ids.
   */
  promote(id: string, at?: string): { store: MemoryStore; memory: Memory } {
    this.requireTiered(id);
    const patch: MemoryPatch = { tier: "long-term", ...(at !== undefined ? { updatedAt: at } : {}) };
    const { memory, repository } = this.repository.update(id, patch);
    return { store: new MemoryStore(repository, this.tier), memory };
  }

  /**
   * Move a memory to the short-term tier (idempotent for short-term
   * memories). When `at` is provided, `updatedAt` becomes `at`. Returns the
   * moved memory plus the successor store.
   */
  demote(id: string, at?: string): { store: MemoryStore; memory: Memory } {
    this.requireTiered(id);
    const patch: MemoryPatch = { tier: "short-term", ...(at !== undefined ? { updatedAt: at } : {}) };
    const { memory, repository } = this.repository.update(id, patch);
    return { store: new MemoryStore(repository, this.tier), memory };
  }

  /**
   * Merge `ids` (at least two, all of this tier) into a single new memory of
   * this tier and remove the sources.
   *
   * The merged memory: deterministic derived id; title/kind/conversationId of
   * the first source by id; content joined with blank lines; source
   * `"derived"`; the highest source importance; `createdAt` of the earliest
   * source; `updatedAt` = `at`; `accessCount` = sum; tags = sorted union;
   * `lastAccessedAt` null; state active. Throws `MemoryMergeError` for fewer
   * than two ids and `MemoryNotFoundError` for unknown ids.
   */
  merge(ids: readonly string[], at: string): { store: MemoryStore; memory: Memory } {
    if (ids.length < 2) throw new MemoryMergeError();
    const sources = sortById(ids.map((id) => this.requireTiered(id)));

    const merged = createMemory({
      title: sources[0].metadata.title,
      content: sources.map((memory) => memory.content).join("\n\n"),
      kind: sources[0].metadata.kind,
      source: "derived",
      importance: sources.reduce(
        (best, memory) =>
          IMPORTANCE_RANK[memory.metadata.importance] > IMPORTANCE_RANK[best]
            ? memory.metadata.importance
            : best,
        sources[0].metadata.importance,
      ),
      tier: this.tier,
      createdAt: sources.reduce(
        (earliest, memory) =>
          Date.parse(memory.metadata.createdAt) < Date.parse(earliest)
            ? memory.metadata.createdAt
            : earliest,
        sources[0].metadata.createdAt,
      ),
      updatedAt: at,
      tags: [...new Set(sources.flatMap((memory) => [...memory.metadata.tags]))].sort(),
      accessCount: sources.reduce((sum, memory) => sum + memory.metadata.accessCount, 0),
      ...(sources[0].metadata.conversationId !== undefined
        ? { conversationId: sources[0].metadata.conversationId }
        : {}),
    });

    let repository = this.repository;
    for (const id of ids) {
      repository = repository.remove(id);
    }
    const { repository: withMerged } = repository.add(merged);
    return { store: new MemoryStore(withMerged, this.tier), memory: merged };
  }

  /**
   * Return the successor store without expired memories of this tier. When
   * `removeArchived` is true, archived memories are removed as well.
   * Deterministic — `now` is supplied by the caller.
   */
  prune(now: string, options: { removeArchived?: boolean } = {}): MemoryStore {
    let repository = this.repository;
    for (const memory of this.tiered()) {
      const expired = isExpired(memory, now);
      const archived = options.removeArchived === true && memory.metadata.state === "archived";
      if (expired || archived) {
        repository = repository.remove(memory.id);
      }
    }
    return new MemoryStore(repository, this.tier);
  }

  /**
   * Return the successor store keeping only the `maxItems` most recent
   * memories of this tier (by `updatedAt`, newest first). A non-positive
   * `maxItems` empties the tier.
   */
  trim(maxItems: number): MemoryStore {
    const tiered = this.tiered();
    const drop =
      maxItems <= 0 ? tiered : sortMemoriesNewestFirst(tiered).slice(maxItems);
    let repository = this.repository;
    for (const memory of drop) {
      repository = repository.remove(memory.id);
    }
    return new MemoryStore(repository, this.tier);
  }

  /** This tier's stored memories (detached clones), in insertion order. */
  private tiered(): Memory[] {
    return this.repository.list().filter((memory) => memory.metadata.tier === this.tier);
  }

  /** Return a detached clone of a stored tier memory or throw. */
  private requireTiered(id: string): Memory {
    const memory = this.repository.find(id);
    if (memory === undefined || memory.metadata.tier !== this.tier) {
      throw new MemoryNotFoundError(id);
    }
    return memory;
  }
}
