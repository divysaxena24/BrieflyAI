/**
 * Production Database Layer — repository (Phase 6A STEP 4).
 *
 * `DatabaseRepository` is the immutable CRUD adapter over a `DatabaseDriver`
 * for one `(scope, collection)` pair. It composes the pure query builders
 * (`./query`) and the transaction manager (`./transaction`):
 *
 * - **Writes** (`insert`, `insertMany`, `update`, `replace`, `softDelete`,
 *   `archive`, …) return the new immutable `DatabaseRecord` and never mutate
 *   caller objects.
 * - **Optimistic locking**: `update`/`softDelete`/`archive`/`unarchive`
 *   accept an optional `expectedRevision` and write through
 *   `compareAndSwap`, throwing `OptimisticLockError` on conflict.
 * - **Reads** (`list`, `paginate`, `cursorPagination`, `search`, `count`)
 *   delegate to `executeDatabaseQuery` and return detached, frozen results.
 * - **Transactions**: `transaction(work)` runs any number of repository
 *   mutations atomically (rollback on throw) and re-exposes the same
 *   repository bound to the transaction handle.
 */

import {
  cloneDatabaseRecord,
  createDatabaseRecord,
  createDatabasePage,
  type DatabaseCollectionKind,
  type DatabasePage,
  type DatabaseRecord,
} from "@/lib/database/types";
import {
  DatabaseRecordDuplicateError,
  DatabaseRecordNotFoundError,
  DatabaseScopeMismatchError,
  OptimisticLockError,
  type DatabaseDriver,
  type DatabaseTransactionHandle,
} from "@/lib/database/driver";
import {
  executeDatabaseQuery,
  buildDatabaseQuery,
  withDatabaseQuery,
  type BuildDatabaseQueryInput,
  type QueryResult,
} from "@/lib/database/query";
import { DatabaseTransactionManager } from "@/lib/database/transaction";

/** Options accepted by the {@link DatabaseRepository} constructor. */
export interface DatabaseRepositoryOptions {
  /** The underlying storage driver (dependency injection). */
  readonly driver: DatabaseDriver;
  /** The caller-supplied namespace (e.g. a user id). */
  readonly scope: string;
  /** The collection the repository manages. */
  readonly collection: DatabaseCollectionKind;
}

/** A patch applied by {@link DatabaseRepository.update}. */
export interface DatabaseRecordPatch {
  /** ISO-8601 UTC timestamp of the modification (caller-supplied). */
  readonly now: string;
  /** Replace the record payload. */
  readonly data?: unknown;
  /** Archive state. */
  readonly archived?: boolean;
  /** Archive timestamp (used when `archived: true`). */
  readonly archivedAt?: string | null;
  /** Soft-delete timestamp (used when soft-deleting). */
  readonly deletedAt?: string | null;
  /** Schema version override. */
  readonly version?: number;
}

/**
 * An immutable repository adapter over a storage driver for one
 * `(scope, collection)`. All reads are detached clones; all writes go
 * through the driver atomically.
 */
export class DatabaseRepository {
  /** The underlying driver (readonly — shared with the transaction manager). */
  readonly driver: DatabaseDriver;
  /** The caller-supplied namespace. */
  readonly scope: string;
  /** The managed collection. */
  readonly collection: DatabaseCollectionKind;

  private readonly manager: DatabaseTransactionManager;

  constructor(options: DatabaseRepositoryOptions) {
    this.driver = options.driver;
    this.scope = options.scope;
    this.collection = options.collection;
    this.manager = new DatabaseTransactionManager({ driver: options.driver });
  }

  // ─────────────────────────────────────────────────────────────
  // Writes
  // ─────────────────────────────────────────────────────────────

  /**
   * Insert a new record. Throws `DatabaseRecordDuplicateError` when a record
   * with the same `recordId` already exists. The record's `scope`/`collection`
   * must match this repository's (envelopes are stored under the repository's
   * identity). Returns the stored record.
   */
  async insert(record: DatabaseRecord<unknown>): Promise<DatabaseRecord<unknown>> {
    this.assertOwned(record);
    const existing = await this.readRecord(record.recordId);
    if (existing !== undefined) {
      throw new DatabaseRecordDuplicateError(this.scope, this.collection, record.recordId);
    }
    await this.driver.upsertAll(this.scope, this.collection, [record]);
    return cloneDatabaseRecord(record);
  }

  /**
   * Insert many records; duplicate or foreign envelopes throw with no partial
   * write. Every record's `scope`/`collection` must match this repository's.
   */
  async insertMany(records: readonly DatabaseRecord<unknown>[]): Promise<readonly DatabaseRecord<unknown>[]> {
    for (const record of records) {
      this.assertOwned(record);
      const existing = await this.readRecord(record.recordId);
      if (existing !== undefined) {
        throw new DatabaseRecordDuplicateError(this.scope, this.collection, record.recordId);
      }
    }
    await this.driver.upsertAll(this.scope, this.collection, [...records]);
    return records.map(cloneDatabaseRecord);
  }

  /**
   * Update an existing record. When `expectedRevision` is given, the write
   * is optimistic-locked (`OptimisticLockError` on conflict). The revision
   * is always bumped. Returns the updated record.
   */
  async update(
    recordId: string,
    patch: DatabaseRecordPatch,
    expectedRevision?: number,
  ): Promise<DatabaseRecord<unknown>> {
    const current = await this.requireRecord(recordId);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new OptimisticLockError(this.scope, this.collection, recordId);
    }
    const successor = createDatabaseRecord({
      id: current.id,
      scope: this.scope,
      collection: this.collection,
      recordId,
      revision: current.revision + 1,
      version: patch.version ?? current.version,
      archived: patch.archived ?? current.archived,
      archivedAt: patch.archivedAt !== undefined ? patch.archivedAt : current.archivedAt,
      deletedAt: patch.deletedAt !== undefined ? patch.deletedAt : current.deletedAt,
      createdAt: current.createdAt,
      updatedAt: patch.now,
      data: patch.data !== undefined ? patch.data : current.data,
    });
    if (expectedRevision !== undefined) {
      await this.driver.compareAndSwap(this.scope, this.collection, successor, expectedRevision);
    } else {
      await this.driver.upsertAll(this.scope, this.collection, [successor]);
    }
    return cloneDatabaseRecord(successor);
  }

  /**
   * Replace a record wholesale (upsert semantics — creates when missing,
   * overwrites the payload and bumps the revision otherwise). Unlike
   * `insert`, a missing record is created rather than rejected; the created
   * envelope is stamped with revision 1 regardless of the input's revision
   * (consistent with the update path, which always bumps). The record's
   * `scope`/`collection` must match this repository's.
   */
  async replace(record: DatabaseRecord<unknown>): Promise<DatabaseRecord<unknown>> {
    this.assertOwned(record);
    const current = await this.readRecord(record.recordId);
    if (current === undefined) {
      const normalized = createDatabaseRecord({
        id: record.id,
        scope: this.scope,
        collection: this.collection,
        recordId: record.recordId,
        revision: 1,
        version: record.version,
        archived: record.archived,
        archivedAt: record.archivedAt,
        deletedAt: record.deletedAt,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        data: record.data,
      });
      await this.driver.upsertAll(this.scope, this.collection, [normalized]);
      return cloneDatabaseRecord(normalized);
    }
    return this.update(record.recordId, {
      now: record.updatedAt,
      data: record.data,
      version: record.version,
      archived: record.archived,
      archivedAt: record.archivedAt,
      deletedAt: record.deletedAt,
    });
  }

  /** Hard-delete a record. Missing records are ignored (idempotent). */
  async delete(recordId: string): Promise<void> {
    await this.driver.deleteMany(this.scope, this.collection, [recordId]);
  }

  /** Soft-delete a record (sets `deletedAt`). Returns the updated record. */
  async softDelete(recordId: string, now: string, expectedRevision?: number): Promise<DatabaseRecord<unknown>> {
    return this.update(recordId, { now, deletedAt: now }, expectedRevision);
  }

  /** Restore a soft-deleted record (clears `deletedAt`). */
  async restore(recordId: string, now: string, expectedRevision?: number): Promise<DatabaseRecord<unknown>> {
    return this.update(recordId, { now, deletedAt: null }, expectedRevision);
  }

  /** Archive a record. Returns the updated record. */
  async archive(recordId: string, now: string, expectedRevision?: number): Promise<DatabaseRecord<unknown>> {
    return this.update(recordId, { now, archived: true, archivedAt: now }, expectedRevision);
  }

  /** Unarchive a record. Returns the updated record. */
  async unarchive(recordId: string, now: string, expectedRevision?: number): Promise<DatabaseRecord<unknown>> {
    return this.update(recordId, { now, archived: false, archivedAt: null }, expectedRevision);
  }

  // ─────────────────────────────────────────────────────────────
  // Reads
  // ─────────────────────────────────────────────────────────────

  /** Whether a record exists (including archived/deleted). */
  async exists(recordId: string): Promise<boolean> {
    return (await this.readRecord(recordId)) !== undefined;
  }

  /** Count records matching a query (defaults to all, active only). */
  async count(query: BuildDatabaseQueryInput = {}): Promise<number> {
    const records = await this.driver.readAll(this.scope, this.collection);
    return executeDatabaseQuery(records, buildDatabaseQuery(query)).total;
  }

  /** List records matching a query (detached, frozen, ordered). */
  async list(query: BuildDatabaseQueryInput = {}): Promise<QueryResult<unknown>> {
    const records = await this.driver.readAll(this.scope, this.collection);
    return executeDatabaseQuery(records, buildDatabaseQuery(query));
  }

  /** Offset pagination. */
  async paginate(
    page: number,
    pageSize: number,
    query: BuildDatabaseQueryInput = {},
  ): Promise<DatabasePage<unknown>> {
    const records = await this.driver.readAll(this.scope, this.collection);
    const built = withDatabaseQuery(buildDatabaseQuery(query), {
      offset: Math.max(0, page - 1) * pageSize,
      limit: pageSize,
    });
    const result = executeDatabaseQuery(records, built);
    return createDatabasePage<unknown>({
      scope: this.scope,
      collection: this.collection,
      page,
      pageSize,
      total: result.total,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor,
      items: result.items,
    });
  }

  /** Cursor pagination (resume-after semantics). */
  async cursorPagination(
    after: string | undefined,
    limit: number,
    query: BuildDatabaseQueryInput = {},
  ): Promise<QueryResult<unknown>> {
    const records = await this.driver.readAll(this.scope, this.collection);
    return executeDatabaseQuery(records, buildDatabaseQuery({ ...query, after, limit }));
  }

  /** Free-text search over recordId, scope and data JSON. */
  async search(term: string, query: BuildDatabaseQueryInput = {}): Promise<QueryResult<unknown>> {
    const records = await this.driver.readAll(this.scope, this.collection);
    return executeDatabaseQuery(records, buildDatabaseQuery({ ...query, search: term }));
  }

  /** Read a single record (detached clone), or `undefined`. */
  async find(recordId: string): Promise<DatabaseRecord<unknown> | undefined> {
    return this.readRecord(recordId);
  }

  // ─────────────────────────────────────────────────────────────
  // Transactions
  // ─────────────────────────────────────────────────────────────

  /**
   * Run `work` inside a transaction with this repository bound to the
   * transaction handle. Any throw rolls back every write in the
   * transaction. Retryable conflicts are retried per the manager policy.
   */
  async transaction<T>(
    work: (repo: DatabaseRepository) => Promise<T>,
  ): Promise<T> {
    return this.manager.run(async (handle) => {
      const txRepo = this.withHandle(handle);
      return work(txRepo);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────────────────────

  /** Reject envelopes whose scope/collection do not match this repository. */
  private assertOwned(record: DatabaseRecord<unknown>): void {
    if (record.scope !== this.scope || record.collection !== this.collection) {
      throw new DatabaseScopeMismatchError(this.scope, this.collection, record.recordId);
    }
  }

  /** Read one record as a detached clone, or `undefined`. */
  private async readRecord(recordId: string): Promise<DatabaseRecord<unknown> | undefined> {
    const records = await this.driver.readAll(this.scope, this.collection);
    return records.find((record) => record.recordId === recordId);
  }

  /** Read one record or throw `DatabaseRecordNotFoundError`. */
  private async requireRecord(recordId: string): Promise<DatabaseRecord<unknown>> {
    const record = await this.readRecord(recordId);
    if (record === undefined) {
      throw new DatabaseRecordNotFoundError(this.scope, this.collection, recordId);
    }
    return record;
  }

  /** A repository sharing this configuration but bound to a transaction handle. */
  private withHandle(handle: DatabaseTransactionHandle): DatabaseRepository {
    const bound: DatabaseDriver = {
      backing: this.driver.backing,
      readAll: (scope, collection) => handle.readAll(scope, collection),
      upsertAll: (scope, collection, records) => handle.upsertAll(scope, collection, records),
      deleteMany: (scope, collection, recordIds) => handle.deleteMany(scope, collection, recordIds),
      clearCollection: (scope, collection) => handle.clearCollection(scope, collection),
      compareAndSwap: (scope, collection, record, expectedRevision) =>
        handle.compareAndSwap(scope, collection, record, expectedRevision),
      transaction: async (innerWork) => {
        // Nested repository transactions re-enter the same handle.
        return innerWork(handle);
      },
    };
    return new DatabaseRepository({ driver: bound, scope: this.scope, collection: this.collection });
  }
}
