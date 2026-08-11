/**
 * Production Database Layer — storage driver contract (Phase 6A STEP 4/5).
 *
 * `DatabaseDriver` is the durable-storage seam of the database layer: a
 * low-level, collection-scoped store of immutable `DatabaseRecord`s, fully
 * dependency-injected. The repository layer (see `./repository`) builds on
 * this contract; the transaction layer (see `./transaction`) adds nested
 * transactions, rollback, retries and optimistic locking on top.
 *
 * Contract guarantees:
 * - reads return detached clones (callers can never alias stored state);
 * - `upsertAll`/`deleteMany`/`clearCollection` are atomic per call;
 * - `compareAndSwap` is the optimistic-lock primitive: it only writes when
 *   the stored record's revision still matches the expected revision,
 *   otherwise it throws `OptimisticLockError` (409) without writing;
 * - `transaction(work)` runs `work` atomically: every write inside commits
 *   together, or everything rolls back when `work` throws.
 *
 * Implementations: `MemoryDatabaseDriver` (deterministic, default — see
 * `./memoryDriver`) and `PostgresDatabaseDriver` (see `./postgresDriver`).
 */

import { AppError } from "@/lib/errors";
import type { DatabaseCollectionKind, DatabaseRecord } from "@/lib/database/types";

/**
 * The storage operations shared by the driver and transaction handles.
 * Implementations must treat records as immutable inputs (frozen on write).
 */
export interface DatabaseStorage {
  /** Read all records of a collection as detached clones. */
  readAll(
    scope: string,
    collection: DatabaseCollectionKind,
  ): Promise<readonly DatabaseRecord<unknown>[]>;

  /** Atomically upsert records into a collection (replace by recordId). */
  upsertAll(
    scope: string,
    collection: DatabaseCollectionKind,
    records: readonly DatabaseRecord<unknown>[],
  ): Promise<void>;

  /** Atomically delete records by id. Missing ids are ignored. */
  deleteMany(
    scope: string,
    collection: DatabaseCollectionKind,
    recordIds: readonly string[],
  ): Promise<void>;

  /** Remove an entire collection. Never throws for missing collections. */
  clearCollection(scope: string, collection: DatabaseCollectionKind): Promise<void>;

  /**
   * Compare-and-swap write: writes `record` only when the stored record with
   * the same id still carries `expectedRevision`. Throws
   * `OptimisticLockError` on mismatch (or when the record is missing).
   */
  compareAndSwap(
    scope: string,
    collection: DatabaseCollectionKind,
    record: DatabaseRecord<unknown>,
    expectedRevision: number,
  ): Promise<void>;
}

/** The operations available inside one transaction. */
export interface DatabaseTransactionHandle extends DatabaseStorage {
  /** Nesting depth of this transaction (0 = top level). */
  readonly depth: number;
}

/** The durable-storage seam the database layer is built on. */
export interface DatabaseDriver extends DatabaseStorage {
  /**
   * Storage backing marker ("memory" or "postgres"). Lets composition roots
   * detect the backing without importing driver implementations.
   */
  readonly backing: "memory" | "postgres";
  /**
   * Run `work` inside a transaction. Every write commits atomically on
   * success; any throw rolls back every write and propagates.
   */
  transaction<T>(work: (handle: DatabaseTransactionHandle) => Promise<T>): Promise<T>;
}

/** Raised by `compareAndSwap` when the stored revision no longer matches. */
export class OptimisticLockError extends AppError {
  constructor(scope: string, collection: DatabaseCollectionKind, recordId: string) {
    super(
      `Optimistic lock conflict on ${scope}/${collection}/${recordId} — the record was modified concurrently`,
      409,
      "optimistic_lock_conflict",
    );
  }
}

/** Raised when a transaction work function throws while holding a lock. */
export class TransactionConflictError extends AppError {
  constructor(detail: string) {
    super(`Transaction conflict: ${detail}`, 409, "transaction_conflict");
  }
}

/** Raised when the driver detects a deadlock; retrying is safe. */
export class TransactionDeadlockError extends AppError {
  constructor(detail: string) {
    super(`Transaction deadlock: ${detail}`, 409, "transaction_deadlock");
  }
}

/** Raised when a transaction is rolled back (generic rollback path). */
export class TransactionRollbackError extends AppError {
  constructor(detail = "Transaction rolled back") {
    super(detail, 500, "transaction_rollback");
  }
}

/** Raised by the repository when a target record does not exist. */
export class DatabaseRecordNotFoundError extends AppError {
  constructor(scope: string, collection: DatabaseCollectionKind, recordId: string) {
    super(
      `No record ${recordId} in ${scope}/${collection}`,
      404,
      "database_record_not_found",
    );
  }
}

/** Raised by the repository when inserting a record that already exists. */
export class DatabaseRecordDuplicateError extends AppError {
  constructor(scope: string, collection: DatabaseCollectionKind, recordId: string) {
    super(
      `Record ${recordId} already exists in ${scope}/${collection}`,
      409,
      "database_record_duplicate",
    );
  }
}

/** Raised when an envelope's scope/collection do not match its repository. */
export class DatabaseScopeMismatchError extends AppError {
  constructor(scope: string, collection: DatabaseCollectionKind, recordId: string) {
    super(
      `Record ${recordId} does not belong to ${scope}/${collection}`,
      400,
      "database_scope_mismatch",
    );
  }
}

/** Retryable errors: conflicts and deadlocks can succeed on a later attempt. */
export function isRetryableDatabaseError(error: unknown): boolean {
  return (
    error instanceof TransactionConflictError || error instanceof TransactionDeadlockError
  );
}
