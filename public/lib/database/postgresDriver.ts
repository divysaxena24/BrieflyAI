/**
 * Production Database Layer — Postgres driver (Phase 6A STEP 9).
 *
 * `PostgresDatabaseDriver` implements the `DatabaseDriver` contract over the
 * existing Drizzle setup (`@/lib/db` + `lib/database/schema.ts`). It maps
 * `DatabaseRecord` envelopes to rows of `database_records`:
 *
 * - timestamps are stored as Postgres timestamptz and returned as ISO-8601
 *   UTC strings (round-trip safe — the envelope contract requires ISO);
 * - `payload` holds the JSON of `data`;
 * - `upsertAll` writes rows with `ON CONFLICT (scope, collection, record_id)`
 *   semantics via the unique index;
 * - `transaction` maps to a Drizzle `db.transaction` (every write in the
 *   transaction commits together, or rolls back on any throw);
 * - `compareAndSwap` performs a conditional UPDATE guarded by `revision`,
 *   so the optimistic lock is enforced by the database itself (0 rows
 *   updated → `OptimisticLockError`).
 *
 * Like `PostgresPersistenceStore` (Phase 5J), this module imports `@/lib/db`
 * which requires `DATABASE_URL` at module load — it is wired by the
 * application, not exercised by unit tests (the in-memory driver is the
 * deterministic test double).
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { databaseRecords } from "@/lib/database/schema";
import {
  cloneDatabaseRecord,
  type DatabaseCollectionKind,
  type DatabaseRecord,
} from "@/lib/database/types";
import {
  OptimisticLockError,
  type DatabaseDriver,
  type DatabaseStorage,
  type DatabaseTransactionHandle,
} from "@/lib/database/driver";

/** The query surface a storage needs: the db client or a transaction. */
type DatabaseExecutor = Pick<
  typeof db,
  "select" | "insert" | "update" | "delete"
>;

/**
 * Convert a row to a detached envelope clone. The schema stores the envelope
 * timestamps as text (ISO-8601), so they round-trip verbatim; `createdAt` /
 * `updatedAt` are Postgres timestamptz and are normalized to ISO-8601 UTC.
 */
function rowToRecord(row: typeof databaseRecords.$inferSelect): DatabaseRecord<unknown> {
  return cloneDatabaseRecord({
    id: row.id,
    scope: row.scope,
    collection: row.collection as DatabaseCollectionKind,
    recordId: row.recordId,
    revision: row.revision,
    version: row.version,
    archived: row.archived,
    archivedAt: row.archivedAt,
    deletedAt: row.deletedAt,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    data: row.payload === "" ? {} : (JSON.parse(row.payload) as unknown),
  });
}

/** Convert an envelope to row values. */
function recordToRow(record: DatabaseRecord<unknown>): typeof databaseRecords.$inferInsert {
  return {
    id: record.id,
    scope: record.scope,
    collection: record.collection,
    recordId: record.recordId,
    revision: record.revision,
    version: record.version,
    archived: record.archived,
    archivedAt: record.archivedAt,
    deletedAt: record.deletedAt,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    payload: JSON.stringify(record.data ?? {}),
  };
}

/** Normalize a timestamptz value to an ISO-8601 UTC string. */
function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Storage bound to a database client or transaction. */
class PostgresStorage implements DatabaseStorage {
  constructor(private readonly executor: DatabaseExecutor) {}

  async readAll(
    scope: string,
    collection: DatabaseCollectionKind,
  ): Promise<readonly DatabaseRecord<unknown>[]> {
    const rows = await this.executor
      .select()
      .from(databaseRecords)
      .where(
        and(
          eq(databaseRecords.scope, scope),
          eq(databaseRecords.collection, collection),
        ),
      )
      .orderBy(databaseRecords.recordId);
    return rows.map(rowToRecord);
  }

  async upsertAll(
    scope: string,
    collection: DatabaseCollectionKind,
    records: readonly DatabaseRecord<unknown>[],
  ): Promise<void> {
    if (records.length === 0) return;
    for (const record of records) {
      const row = recordToRow(record);
      await this.executor
        .insert(databaseRecords)
        .values(row)
        .onConflictDoUpdate({
          target: [databaseRecords.scope, databaseRecords.collection, databaseRecords.recordId],
          set: {
            revision: record.revision,
            version: record.version,
            archived: record.archived,
            archivedAt: row.archivedAt,
            deletedAt: row.deletedAt,
            updatedAt: row.updatedAt,
            payload: row.payload,
          },
        });
    }
  }

  async deleteMany(
    scope: string,
    collection: DatabaseCollectionKind,
    recordIds: readonly string[],
  ): Promise<void> {
    if (recordIds.length === 0) return;
    await this.executor
      .delete(databaseRecords)
      .where(
        and(
          eq(databaseRecords.scope, scope),
          eq(databaseRecords.collection, collection),
          inArray(databaseRecords.recordId, [...recordIds]),
        ),
      );
  }

  async clearCollection(scope: string, collection: DatabaseCollectionKind): Promise<void> {
    await this.executor
      .delete(databaseRecords)
      .where(
        and(
          eq(databaseRecords.scope, scope),
          eq(databaseRecords.collection, collection),
        ),
      );
  }

  async compareAndSwap(
    scope: string,
    collection: DatabaseCollectionKind,
    record: DatabaseRecord<unknown>,
    expectedRevision: number,
  ): Promise<void> {
    const row = recordToRow(record);
    const result = await this.executor
      .update(databaseRecords)
      .set({
        revision: record.revision,
        version: record.version,
        archived: record.archived,
        archivedAt: row.archivedAt,
        deletedAt: row.deletedAt,
        updatedAt: row.updatedAt,
        payload: row.payload,
      })
      .where(
        and(
          eq(databaseRecords.scope, scope),
          eq(databaseRecords.collection, collection),
          eq(databaseRecords.recordId, record.recordId),
          eq(databaseRecords.revision, expectedRevision),
        ),
      )
      .returning({ id: databaseRecords.id });
    if (result.length === 0) {
      throw new OptimisticLockError(scope, collection, record.recordId);
    }
  }
}

/**
 * Postgres-backed database driver over the Drizzle singleton. Lazy by
 * construction — no query runs until a method is called.
 */
export class PostgresDatabaseDriver implements DatabaseDriver {
  /** Storage backing marker (used by the production wiring). */
  readonly backing = "postgres" as const;

  /** Read all records of a collection as detached clones. */
  async readAll(
    scope: string,
    collection: DatabaseCollectionKind,
  ): Promise<readonly DatabaseRecord<unknown>[]> {
    return new PostgresStorage(db).readAll(scope, collection);
  }

  /** Atomically upsert records (ON CONFLICT by scope+collection+recordId). */
  async upsertAll(
    scope: string,
    collection: DatabaseCollectionKind,
    records: readonly DatabaseRecord<unknown>[],
  ): Promise<void> {
    return new PostgresStorage(db).upsertAll(scope, collection, records);
  }

  /** Atomically delete records by id. */
  async deleteMany(
    scope: string,
    collection: DatabaseCollectionKind,
    recordIds: readonly string[],
  ): Promise<void> {
    return new PostgresStorage(db).deleteMany(scope, collection, recordIds);
  }

  /** Remove an entire collection. */
  async clearCollection(scope: string, collection: DatabaseCollectionKind): Promise<void> {
    return new PostgresStorage(db).clearCollection(scope, collection);
  }

  /** Compare-and-swap write guarded by the database revision column. */
  async compareAndSwap(
    scope: string,
    collection: DatabaseCollectionKind,
    record: DatabaseRecord<unknown>,
    expectedRevision: number,
  ): Promise<void> {
    return new PostgresStorage(db).compareAndSwap(scope, collection, record, expectedRevision);
  }

  /**
   * Run `work` inside a Postgres transaction (Drizzle `db.transaction`).
   * Every write commits together on success; any throw rolls everything
   * back and propagates.
   */
  async transaction<T>(
    work: (handle: DatabaseTransactionHandle) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      const storage = new PostgresStorage(tx as unknown as DatabaseExecutor);
      const handle: DatabaseTransactionHandle = {
        depth: 0,
        readAll: (scope, collection) => storage.readAll(scope, collection),
        upsertAll: (scope, collection, records) => storage.upsertAll(scope, collection, records),
        deleteMany: (scope, collection, recordIds) => storage.deleteMany(scope, collection, recordIds),
        clearCollection: (scope, collection) => storage.clearCollection(scope, collection),
        compareAndSwap: (scope, collection, record, expectedRevision) =>
          storage.compareAndSwap(scope, collection, record, expectedRevision),
      };
      return work(handle);
    });
  }
}

/** Build a fresh Postgres-backed database driver. */
export function createPostgresDatabaseDriver(): PostgresDatabaseDriver {
  return new PostgresDatabaseDriver();
}
