/**
 * Persistence layer — in-memory store (Phase 5J STEP 2/3).
 *
 * `MemoryPersistenceStore` is a real, self-contained `PersistenceStore`
 * implementation that keeps `StoredCollection`s in an immutable,
 * clone-on-read map. It is the deterministic default store (no database
 * required) and the store the tests exercise the persistence contract
 * against. The Postgres-backed store (`./dbStore`) implements the same
 * contract over the existing Drizzle setup.
 */

import { createStoredCollection, type CollectionKind, type PersistenceStore, type StoredCollection } from "./types";

/**
 * In-memory persistence store.
 *
 * The store is stateful by design (it is the persistence composition root,
 * mirroring the engine composition roots): `write` replaces the stored
 * collection wholesale (full-snapshot semantics), `read` returns a detached
 * clone, and `clear` removes. The `StoredCollection` values themselves are
 * immutable and never aliased by readers.
 */
export class MemoryPersistenceStore implements PersistenceStore {
  /** Stored collections keyed by `${scope}:${kind}`, frozen values. */
  private collections: ReadonlyMap<string, StoredCollection>;

  constructor(initial: readonly StoredCollection[] = []) {
    const map = new Map<string, StoredCollection>();
    for (const collection of initial) {
      map.set(`${collection.scope}:${collection.kind}`, Object.freeze({ ...collection }));
    }
    this.collections = map;
  }

  /** Read a detached clone of the stored collection, or `undefined`. */
  async read(scope: string, kind: CollectionKind): Promise<StoredCollection | undefined> {
    const stored = this.collections.get(`${scope}:${kind}`);
    return stored === undefined ? undefined : { ...stored };
  }

  /** Replace (or insert) the stored collection for `(scope, kind)`. */
  async write(scope: string, kind: CollectionKind, collection: StoredCollection): Promise<void> {
    const stored = createStoredCollection({
      scope,
      kind,
      version: collection.version,
      payload: collection.payload,
    });
    const next = new Map(this.collections);
    next.set(`${scope}:${kind}`, stored);
    this.replaceMap(next);
  }

  /** Remove the stored collection for `(scope, kind)`. Never throws. */
  async clear(scope: string, kind: CollectionKind): Promise<void> {
    const key = `${scope}:${kind}`;
    if (!this.collections.has(key)) return;
    const next = new Map(this.collections);
    next.delete(key);
    this.replaceMap(next);
  }

  /** Whether a collection is stored. */
  has(scope: string, kind: CollectionKind): boolean {
    return this.collections.has(`${scope}:${kind}`);
  }

  /** Number of stored collections. */
  count(): number {
    return this.collections.size;
  }

  /** Detached clones of every stored collection, in insertion order. */
  list(): StoredCollection[] {
    return [...this.collections.values()].map((collection) => ({ ...collection }));
  }

  /** Return a new, empty store. The receiver is never modified. */
  clearAll(): MemoryPersistenceStore {
    return new MemoryPersistenceStore();
  }

  /** Swap the internal map (private — the store is stateful by design). */
  private replaceMap(next: ReadonlyMap<string, StoredCollection>): void {
    this.collections = next;
  }
}
