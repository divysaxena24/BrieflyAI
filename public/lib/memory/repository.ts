/**
 * Memory Engine — immutable in-memory memory repository.
 *
 * `MemoryRepository` is the storage facade of the memory layer: a private,
 * immutable collection of `Memory` objects held in insertion order. Every
 * mutation returns a NEW repository — the original is never changed.
 *
 * Guarantees:
 * - **Constructor snapshot**: the initial memories are copied on entry;
 *   later caller mutation of those objects never affects the repository.
 * - **Detached clones**: every stored memory is deep-frozen internally, and
 *   every read returns a fresh detached clone.
 * - **Insertion order**: `list()` returns memories in creation order;
 *   `update`/`replace` keep a memory's position; `remove` removes it.
 * - **No caching, no singleton, no storage, no database**.
 *
 * All operations are deterministic: identical operation sequences produce
 * deep-equal repository states.
 */

import { AppError } from "@/lib/errors";
import {
  cloneMemory,
  freezeMemory,
  type Memory,
  type MemoryImportance,
  type MemoryKind,
  type MemoryMetadata,
  type MemorySource,
  type MemoryState,
  type MemoryTier,
} from "./types";

/** Raised when an operation targets a memory id that is not stored. */
export class MemoryNotFoundError extends AppError {
  constructor(memoryId: string) {
    super(`Memory not found: ${memoryId}`, 404, "memory_not_found");
  }
}

/** Raised when a memory is added with an id that is already stored. */
export class MemoryDuplicateError extends AppError {
  constructor(memoryId: string) {
    super(`Memory already exists: ${memoryId}`, 409, "memory_duplicate_id");
  }
}

/**
 * A partial patch applied by {@link MemoryRepository.update}.
 *
 * Keys present in the patch are applied; missing keys are preserved. A `null`
 * value for `conversationId`/`expiresAt` clears the optional field.
 */
export type MemoryPatch = Partial<{
  title: string;
  content: string;
  kind: MemoryKind;
  source: MemorySource;
  importance: MemoryImportance;
  tier: MemoryTier;
  state: MemoryState;
  updatedAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
  tags: readonly string[];
  conversationId: string | null;
  expiresAt: string | null;
  extra?: Readonly<Record<string, unknown>>;
}>;

/**
 * Immutable in-memory collection of memories.
 *
 * All methods are pure with respect to the repository: reads never mutate,
 * and mutations return the successor repository without touching `this`.
 */
export class MemoryRepository {
  /** The stored memories, oldest first, deep-frozen. */
  private readonly memories: readonly Memory[];

  /**
   * Build a repository from an initial set of memories.
   *
   * Every memory is copied (detached from the caller) and deep-frozen; the
   * internal array itself is frozen. Insertion order is preserved.
   */
  constructor(initialMemories: readonly Memory[] = []) {
    this.memories = Object.freeze(
      initialMemories.map((memory) => freezeMemory(cloneMemory(memory))),
    );
  }

  /**
   * Store a new memory (appended at the end). Throws
   * `MemoryDuplicateError` for an already-stored id. Returns the stored
   * memory plus the successor repository.
   */
  add(memory: Memory): { memory: Memory; repository: MemoryRepository } {
    if (this.has(memory.id)) {
      throw new MemoryDuplicateError(memory.id);
    }
    const stored = freezeMemory(cloneMemory(memory));
    return {
      memory: stored,
      repository: new MemoryRepository([...this.memories, stored]),
    };
  }

  /**
   * Apply a partial patch to the stored memory with the given id.
   *
   * Missing patch keys are preserved; `tags`/`extra` are copied; a `null`
   * `conversationId`/`expiresAt` clears the field. Throws
   * `MemoryNotFoundError` for unknown ids. Returns the patched memory (a new
   * object) plus the successor repository (position preserved).
   */
  update(id: string, patch: MemoryPatch): { memory: Memory; repository: MemoryRepository } {
    const current = this.require(id);
    // Built field-by-field so that a `null` patch value can clear an optional
    // field (a spread of `current.metadata` would keep it).
    const metadata: MemoryMetadata = {
      title: patch.title ?? current.metadata.title,
      kind: patch.kind ?? current.metadata.kind,
      source: patch.source ?? current.metadata.source,
      importance: patch.importance ?? current.metadata.importance,
      tier: patch.tier ?? current.metadata.tier,
      state: patch.state ?? current.metadata.state,
      createdAt: current.metadata.createdAt,
      updatedAt: patch.updatedAt ?? current.metadata.updatedAt,
      lastAccessedAt:
        patch.lastAccessedAt !== undefined
          ? patch.lastAccessedAt
          : current.metadata.lastAccessedAt,
      accessCount: patch.accessCount ?? current.metadata.accessCount,
      tags: patch.tags !== undefined ? [...patch.tags] : [...current.metadata.tags],
      ...(patch.conversationId !== undefined
        ? patch.conversationId !== null
          ? { conversationId: patch.conversationId }
          : {}
        : current.metadata.conversationId !== undefined
          ? { conversationId: current.metadata.conversationId }
          : {}),
      ...(patch.expiresAt !== undefined
        ? patch.expiresAt !== null
          ? { expiresAt: patch.expiresAt }
          : {}
        : current.metadata.expiresAt !== undefined
          ? { expiresAt: current.metadata.expiresAt }
          : {}),
    };

    const updated: Memory = {
      id: current.id,
      metadata,
      content: patch.content ?? current.content,
      ...(patch.extra !== undefined
        ? { extra: { ...patch.extra } }
        : current.extra !== undefined
          ? { extra: { ...current.extra } }
          : {}),
    };

    return {
      memory: cloneMemory(updated),
      repository: new MemoryRepository(
        this.memories.map((stored) =>
          stored.id === id ? freezeMemory(cloneMemory(updated)) : stored,
        ),
      ),
    };
  }

  /**
   * Replace the stored memory with the same id by a detached copy of
   * `memory`. The memory keeps its insertion position. Throws
   * `MemoryNotFoundError` for unknown ids.
   */
  replace(memory: Memory): MemoryRepository {
    this.require(memory.id);
    return new MemoryRepository(
      this.memories.map((stored) =>
        stored.id === memory.id ? freezeMemory(cloneMemory(memory)) : stored,
      ),
    );
  }

  /** Remove the memory with the given id. Throws for unknown ids. */
  remove(id: string): MemoryRepository {
    this.require(id);
    return new MemoryRepository(this.memories.filter((memory) => memory.id !== id));
  }

  /** Return a new, empty repository. The receiver is never modified. */
  clear(): MemoryRepository {
    return new MemoryRepository();
  }

  /** Return a detached clone of the stored memory, or `undefined`. */
  find(id: string): Memory | undefined {
    const stored = this.memories.find((memory) => memory.id === id);
    return stored === undefined ? undefined : cloneMemory(stored);
  }

  /** Return detached clones of every memory with the given kind, in order. */
  findByKind(kind: MemoryKind): Memory[] {
    return this.list().filter((memory) => memory.metadata.kind === kind);
  }

  /** Return detached clones of every memory tagged with `tag`, in order. */
  findByTag(tag: string): Memory[] {
    return this.list().filter((memory) => memory.metadata.tags.includes(tag));
  }

  /** Return detached clones of every memory with the given importance, in order. */
  findByImportance(importance: MemoryImportance): Memory[] {
    return this.list().filter((memory) => memory.metadata.importance === importance);
  }

  /** Return detached clones of every memory with the given source, in order. */
  findBySource(source: MemorySource): Memory[] {
    return this.list().filter((memory) => memory.metadata.source === source);
  }

  /** Return detached clones of every stored memory, in insertion order. */
  list(): Memory[] {
    return this.memories.map(cloneMemory);
  }

  /** Whether a memory with the given id is stored. */
  has(id: string): boolean {
    return this.memories.some((memory) => memory.id === id);
  }

  /** Number of stored memories. */
  count(): number {
    return this.memories.length;
  }

  /** Throw `MemoryNotFoundError` unless the id is stored. */
  private require(id: string): Memory {
    const stored = this.memories.find((memory) => memory.id === id);
    if (stored === undefined) {
      throw new MemoryNotFoundError(id);
    }
    return stored;
  }
}
