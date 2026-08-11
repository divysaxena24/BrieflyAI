/**
 * Production Database Layer — in-memory driver (Phase 6A STEP 4).
 *
 * `MemoryDatabaseDriver` is the deterministic default implementation of the
 * `DatabaseDriver` contract. It keeps records in an immutable, successor-
 * pattern state map (`state` is never mutated — every write replaces the
 * outer map), so:
 *
 * - reads return detached clones (callers can never alias stored state);
 * - stored records are deep-frozen (frozen storage);
 * - transactions are checkpoint-based: `transaction(work)` captures a
 *   reference to the current immutable state; because every mutation
 *   replaces the state (successor pattern), the checkpoint is a complete
 *   snapshot. Rollback restores the checkpoint; commit discards it. Nested
 *   transactions work naturally (each level captures its own checkpoint).
 *
 * The driver is stateful by design (it is the storage composition root) but
 * its *state* is immutable — there is no global mutable state.
 */

import {
  cloneDatabaseRecord,
  freezeDatabaseRecord,
  type DatabaseCollectionKind,
  type DatabaseRecord,
} from "@/lib/database/types";
import {
  isRetryableDatabaseError,
  OptimisticLockError,
  type DatabaseDriver,
  type DatabaseStorage,
  type DatabaseTransactionHandle,
} from "@/lib/database/driver";

/** The backing marker for the in-memory driver. */
export const MEMORY_DRIVER_BACKING = "memory" as const;

/** State key: `${scope}\u0000${collection}`. */
function stateKey(scope: string, collection: DatabaseCollectionKind): string {
  return `${scope}\u0000${collection}`;
}

/** Copy-on-write inner map with a record upserted (frozen). */
function withRecord(
  inner: ReadonlyMap<string, DatabaseRecord<unknown>> | undefined,
  record: DatabaseRecord<unknown>,
): ReadonlyMap<string, DatabaseRecord<unknown>> {
  const next = new Map(inner ?? []);
  next.set(record.recordId, freezeDatabaseRecord(record));
  return next;
}

/** Copy-on-write inner map with records removed. */
function withoutRecords(
  inner: ReadonlyMap<string, DatabaseRecord<unknown>> | undefined,
  recordIds: readonly string[],
): ReadonlyMap<string, DatabaseRecord<unknown>> {
  const next = new Map(inner ?? []);
  for (const recordId of recordIds) next.delete(recordId);
  return next;
}

/** Copy-on-write outer map (successor pattern). */
function withCollection(
  state: ReadonlyMap<string, ReadonlyMap<string, DatabaseRecord<unknown>>>,
  key: string,
  inner: ReadonlyMap<string, DatabaseRecord<unknown>>,
): ReadonlyMap<string, ReadonlyMap<string, DatabaseRecord<unknown>>> {
  const next = new Map(state);
  next.set(key, inner);
  return next;
}

/** Copy-on-write outer map with a collection removed. */
function withoutCollection(
  state: ReadonlyMap<string, ReadonlyMap<string, DatabaseRecord<unknown>>>,
  key: string,
): ReadonlyMap<string, ReadonlyMap<string, DatabaseRecord<unknown>>> {
  const next = new Map(state);
  next.delete(key);
  return next;
}

/** A storage adapter bound to one snapshot of the driver state. */
class MemoryStorage implements DatabaseStorage {
  constructor(
    private readonly getState: () => ReadonlyMap<
      string,
      ReadonlyMap<string, DatabaseRecord<unknown>>
    >,
    private readonly commit: (state: ReadonlyMap<string, ReadonlyMap<string, DatabaseRecord<unknown>>>) => void,
  ) {}

  async readAll(
    scope: string,
    collection: DatabaseCollectionKind,
  ): Promise<readonly DatabaseRecord<unknown>[]> {
    const inner = this.getState().get(stateKey(scope, collection));
    if (inner === undefined) return [];
    return [...inner.values()].map(cloneDatabaseRecord);
  }

  async upsertAll(
    scope: string,
    collection: DatabaseCollectionKind,
    records: readonly DatabaseRecord<unknown>[],
  ): Promise<void> {
    const key = stateKey(scope, collection);
    const state = this.getState();
    let inner = state.get(key);
    for (const record of records) {
      inner = withRecord(inner, record);
    }
    this.commit(withCollection(state, key, inner ?? new Map()));
  }

  async deleteMany(
    scope: string,
    collection: DatabaseCollectionKind,
    recordIds: readonly string[],
  ): Promise<void> {
    if (recordIds.length === 0) return;
    const key = stateKey(scope, collection);
    const state = this.getState();
    const inner = state.get(key);
    if (inner === undefined) return;
    this.commit(withCollection(state, key, withoutRecords(inner, recordIds)));
  }

  async clearCollection(scope: string, collection: DatabaseCollectionKind): Promise<void> {
    this.commit(withoutCollection(this.getState(), stateKey(scope, collection)));
  }

  async compareAndSwap(
    scope: string,
    collection: DatabaseCollectionKind,
    record: DatabaseRecord<unknown>,
    expectedRevision: number,
  ): Promise<void> {
    const inner = this.getState().get(stateKey(scope, collection));
    const stored = inner?.get(record.recordId);
    if (stored === undefined || stored.revision !== expectedRevision) {
      throw new OptimisticLockError(scope, collection, record.recordId);
    }
    const key = stateKey(scope, collection);
    this.commit(withCollection(this.getState(), key, withRecord(inner, record)));
  }
}

/**
 * Deterministic in-memory database driver. State is immutable and replaced
 * wholesale on every write; transactions snapshot the state by reference.
 */
export class MemoryDatabaseDriver implements DatabaseDriver {
  /** Storage backing marker (used by the production wiring). */
  readonly backing: typeof MEMORY_DRIVER_BACKING = MEMORY_DRIVER_BACKING;

  /** The immutable state map (successor pattern — never mutated in place). */
  private state: ReadonlyMap<string, ReadonlyMap<string, DatabaseRecord<unknown>>> = new Map();

  /** Current transaction nesting depth (0 = no active transaction). */
  private depth = 0;

  /** Read all records of a collection as detached clones. */
  async readAll(
    scope: string,
    collection: DatabaseCollectionKind,
  ): Promise<readonly DatabaseRecord<unknown>[]> {
    return new MemoryStorage(
      () => this.state,
      (next) => {
        this.state = next;
      },
    ).readAll(scope, collection);
  }

  /** Atomically upsert records into a collection. */
  async upsertAll(
    scope: string,
    collection: DatabaseCollectionKind,
    records: readonly DatabaseRecord<unknown>[],
  ): Promise<void> {
    await new MemoryStorage(
      () => this.state,
      (next) => {
        this.state = next;
      },
    ).upsertAll(scope, collection, records);
  }

  /** Atomically delete records by id. */
  async deleteMany(
    scope: string,
    collection: DatabaseCollectionKind,
    recordIds: readonly string[],
  ): Promise<void> {
    await new MemoryStorage(
      () => this.state,
      (next) => {
        this.state = next;
      },
    ).deleteMany(scope, collection, recordIds);
  }

  /** Remove an entire collection. */
  async clearCollection(scope: string, collection: DatabaseCollectionKind): Promise<void> {
    await new MemoryStorage(
      () => this.state,
      (next) => {
        this.state = next;
      },
    ).clearCollection(scope, collection);
  }

  /** Compare-and-swap write (optimistic lock primitive). */
  async compareAndSwap(
    scope: string,
    collection: DatabaseCollectionKind,
    record: DatabaseRecord<unknown>,
    expectedRevision: number,
  ): Promise<void> {
    await new MemoryStorage(
      () => this.state,
      (next) => {
        this.state = next;
      },
    ).compareAndSwap(scope, collection, record, expectedRevision);
  }

  /**
   * Run `work` inside a checkpoint-based transaction. Every write commits
   * on success; any throw restores the pre-transaction state and propagates.
   */
  async transaction<T>(
    work: (handle: DatabaseTransactionHandle) => Promise<T>,
  ): Promise<T> {
    const checkpoint = this.state;
    const depth = this.depth;
    this.depth = depth + 1;
    const handle = this.createHandle(depth);
    try {
      const result = await work(handle);
      this.depth = depth;
      return result;
    } catch (error) {
      this.state = checkpoint;
      this.depth = depth;
      throw error;
    }
  }

  /** The current transaction nesting depth (0 when idle). */
  get transactionDepth(): number {
    return this.depth;
  }

  /** Total number of stored records across all collections. */
  count(): number {
    let total = 0;
    for (const inner of this.state.values()) total += inner.size;
    return total;
  }

  /**
   * The raw stored records of a collection. Safe to expose because stored
   * records are deep-frozen — callers cannot mutate them. Primarily used by
   * tests to verify frozen storage.
   */
  recordsOf(
    scope: string,
    collection: DatabaseCollectionKind,
  ): readonly DatabaseRecord<unknown>[] {
    const inner = this.state.get(stateKey(scope, collection));
    if (inner === undefined) return [];
    return [...inner.values()];
  }

  /** Whether any records are stored under `(scope, collection)`. */
  has(scope: string, collection: DatabaseCollectionKind): boolean {
    return this.state.has(stateKey(scope, collection));
  }

  /** Detached clones of every stored record across all collections. */
  listAll(): readonly DatabaseRecord<unknown>[] {
    const out: DatabaseRecord<unknown>[] = [];
    for (const inner of this.state.values()) {
      for (const record of inner.values()) out.push(cloneDatabaseRecord(record));
    }
    return out;
  }

  /** Return a fresh, empty driver (isolated storage). */
  empty(): MemoryDatabaseDriver {
    return new MemoryDatabaseDriver();
  }

  /** Create a transaction handle bound to the driver's current state. */
  private createHandle(depth: number): DatabaseTransactionHandle {
    const storage = new MemoryStorage(
      () => this.state,
      (next) => {
        this.state = next;
      },
    );
    const handle: DatabaseTransactionHandle = {
      depth,
      readAll: (scope, collection) => storage.readAll(scope, collection),
      upsertAll: (scope, collection, records) => storage.upsertAll(scope, collection, records),
      deleteMany: (scope, collection, recordIds) => storage.deleteMany(scope, collection, recordIds),
      clearCollection: (scope, collection) => storage.clearCollection(scope, collection),
      compareAndSwap: (scope, collection, record, expectedRevision) =>
        storage.compareAndSwap(scope, collection, record, expectedRevision),
    };
    return handle;
  }
}

/** Convenience guard: whether an error can be retried by the transaction manager. */
export { isRetryableDatabaseError };
