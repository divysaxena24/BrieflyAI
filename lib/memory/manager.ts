/**
 * Memory Engine — memory manager (pure orchestration).
 *
 * The operation-facing facade over `MemoryRepository`. Every mutation is an
 * immutable step: the receiver is never changed, and each operation returns
 * the successor manager (with the successor repository) plus any artifact it
 * produced (created/updated memory).
 *
 * Uses only `MemoryRepository` — no persistence, no database, no AI.
 *
 * Lifecycle: `remember` → `updateMemory` / `touchMemory` / `archiveMemory` /
 * `restoreMemory` / `forget` / `deleteMemory`.
 */

import { MemoryNotFoundError, MemoryRepository, type MemoryPatch } from "./repository";
import {
  createMemory,
  touchMemory as touchMemoryHelper,
  type CreateMemoryInput,
  type Memory,
} from "./types";

/**
 * Pure in-memory orchestration over a `MemoryRepository`.
 *
 * The backing repository is exposed as a public readonly field so downstream
 * composition (retrieval, search, production wiring) can read the exact state
 * this manager operates on.
 */
export class MemoryManager {
  /** The backing immutable repository (never replaced in place). */
  readonly repository: MemoryRepository;

  /**
   * Build a manager over a repository. When omitted, an empty repository is
   * used.
   */
  constructor(repository: MemoryRepository = new MemoryRepository()) {
    this.repository = repository;
  }

  /** Return a detached clone of the stored memory, or `undefined`. */
  find(id: string): Memory | undefined {
    return this.repository.find(id);
  }

  /** Return detached clones of every stored memory, in insertion order. */
  list(): Memory[] {
    return this.repository.list();
  }

  /** Whether a memory with the given id is stored. */
  has(id: string): boolean {
    return this.repository.has(id);
  }

  /** Number of stored memories. */
  count(): number {
    return this.repository.count();
  }

  /**
   * Build and store a new memory (via `createMemory` with defaults) and
   * return it plus the successor manager. Throws `MemoryDuplicateError` for
   * an already-stored id.
   */
  remember(input: CreateMemoryInput): { manager: MemoryManager; memory: Memory } {
    const memory = createMemory(input);
    const { memory: stored, repository } = this.repository.add(memory);
    return { manager: new MemoryManager(repository), memory: stored };
  }

  /**
   * Return the successor manager with the memory's state set to `"deleted"` —
   * a soft delete: the memory stays stored and is recoverable via
   * `restoreMemory`. Distinct from `deleteMemory`, which removes the memory
   * entirely. Throws `MemoryNotFoundError` for unknown ids.
   */
  forget(id: string): MemoryManager {
    return new MemoryManager(this.repository.update(id, { state: "deleted" }).repository);
  }

  /**
   * Apply a partial patch to a memory (title, content, kind, importance,
   * tags, ...) and return the patched memory plus the successor manager.
   * Throws `MemoryNotFoundError` for unknown ids.
   */
  updateMemory(id: string, changes: MemoryPatch): { manager: MemoryManager; memory: Memory } {
    const { memory, repository } = this.repository.update(id, changes);
    return { manager: new MemoryManager(repository), memory };
  }

  /**
   * Record an access to a memory: `lastAccessedAt` becomes `at` and
   * `accessCount` increments. `updatedAt` is unchanged (see `touchMemory` in
   * `./types`). Throws `MemoryNotFoundError` for unknown ids.
   */
  touchMemory(id: string, at: string): { manager: MemoryManager; memory: Memory } {
    const current = this.require(id);
    const touched = touchMemoryHelper(current, at);
    const repository = this.repository.replace(touched);
    return { manager: new MemoryManager(repository), memory: touched };
  }

  /** Return the successor manager with the memory's state set to `"archived"`. */
  archiveMemory(id: string): MemoryManager {
    return new MemoryManager(this.repository.update(id, { state: "archived" }).repository);
  }

  /** Return the successor manager with the memory's state set to `"active"`. */
  restoreMemory(id: string): MemoryManager {
    return new MemoryManager(this.repository.update(id, { state: "active" }).repository);
  }

  /** Return the successor manager with the memory removed entirely (hard delete). */
  deleteMemory(id: string): MemoryManager {
    return new MemoryManager(this.repository.remove(id));
  }

  /**
   * Remember many memories atomically. Returns the successor manager plus
   * every stored memory. Throws `MemoryDuplicateError` on the first duplicate
   * id (the receiver is unchanged either way).
   */
  bulkRemember(inputs: readonly CreateMemoryInput[]): {
    manager: MemoryManager;
    added: Memory[];
  } {
    let repository = this.repository;
    const added: Memory[] = [];
    for (const input of inputs) {
      const memory = createMemory(input);
      const result = repository.add(memory);
      repository = result.repository;
      added.push(result.memory);
    }
    return { manager: new MemoryManager(repository), added };
  }

  /**
   * Soft-delete many memories atomically. Throws `MemoryNotFoundError` on the
   * first unknown id (the receiver is unchanged either way).
   */
  bulkForget(ids: readonly string[]): MemoryManager {
    let repository = this.repository;
    for (const id of ids) {
      repository = repository.update(id, { state: "deleted" }).repository;
    }
    return new MemoryManager(repository);
  }

  /** Return a detached clone of the stored memory or throw. */
  private require(id: string): Memory {
    const memory = this.repository.find(id);
    if (memory === undefined) {
      throw new MemoryNotFoundError(id);
    }
    return memory;
  }
}
