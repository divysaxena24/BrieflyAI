/**
 * Production Database Layer — transaction manager (Phase 6A STEP 5).
 *
 * `DatabaseTransactionManager` layers retries, nesting bookkeeping and
 * optimistic locking over the driver's `transaction` primitive.
 *
 * - **Nested transactions**: `run` tracks depth; the driver's checkpoint
 *   semantics give each level its own rollback boundary.
 * - **Rollback**: a throwing work function rolls back every write of that
 *   transaction level and propagates.
 * - **Retries**: `TransactionConflictError` / `TransactionDeadlockError`
 *   (see `isRetryableDatabaseError`) are retried up to `maxAttempts` with
 *   exponential backoff. The sleep function is dependency-injected so tests
 *   stay deterministic (no real timers).
 * - **Optimistic locking**: `withOptimisticLock` performs the canonical
 *   read-modify-CAS-write cycle inside the current transaction — it re-reads
 *   the record, applies a pure mutation, bumps the revision and writes via
 *   `compareAndSwap`, throwing `OptimisticLockError` on conflict.
 *
 * Everything is dependency-injected; there is no global mutable state.
 */

import type { DatabaseCollectionKind, DatabaseRecord } from "@/lib/database/types";
import {
  DatabaseRecordNotFoundError,
  isRetryableDatabaseError,
  type DatabaseDriver,
  type DatabaseTransactionHandle,
} from "@/lib/database/driver";
import { createDatabaseRecord, freezeDatabaseRecord } from "@/lib/database/types";

/** Retry policy for retryable transaction failures. */
export interface DatabaseRetryPolicy {
  /** Total attempts including the first (>= 1). */
  readonly maxAttempts: number;
  /** Base backoff in ms (doubled each attempt). */
  readonly baseDelayMs: number;
  /** Backoff ceiling in ms. */
  readonly maxDelayMs: number;
}

/** Default retry policy: 3 attempts, 10ms base, 80ms ceiling. */
export const DEFAULT_DATABASE_RETRY_POLICY: DatabaseRetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 10,
  maxDelayMs: 80,
});

/** Options accepted by the {@link DatabaseTransactionManager}. */
export interface DatabaseTransactionManagerOptions {
  /** The underlying driver (dependency injection). */
  readonly driver: DatabaseDriver;
  /** Retry policy (default: {@link DEFAULT_DATABASE_RETRY_POLICY}). */
  readonly retry?: DatabaseRetryPolicy;
  /** Sleep function (dependency injection; default: `setTimeout` promise). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The canonical optimistic-lock update: read → mutate → CAS write. */
export interface OptimisticLockUpdate<T = unknown> {
  /** ISO-8601 UTC timestamp of the update (caller-supplied). */
  readonly now: string;
  /**
   * Pure mutation applied to the current record's data. Must return a new
   * data payload (never mutate the input). When omitted, data is unchanged.
   */
  readonly mutateData?: (current: T) => T;
}

/**
 * Transaction manager: retries, nesting bookkeeping, rollback and optimistic
 * locking over a `DatabaseDriver`.
 */
export class DatabaseTransactionManager {
  /** The underlying driver. */
  readonly driver: DatabaseDriver;

  private readonly retryPolicy: DatabaseRetryPolicy;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: DatabaseTransactionManagerOptions) {
    this.driver = options.driver;
    this.retryPolicy = options.retry ?? DEFAULT_DATABASE_RETRY_POLICY;
    this.sleepFn = options.sleep ?? defaultSleep;
  }

  /**
   * Run `work` inside a transaction with retry-on-conflict semantics.
   * Retryable errors are retried per the policy with exponential backoff;
   * non-retryable errors propagate immediately. Every throw rolls the
   * transaction back.
   */
  async run<T>(
    work: (handle: DatabaseTransactionHandle) => Promise<T>,
    options: { readonly retry?: DatabaseRetryPolicy } = {},
  ): Promise<T> {
    const policy = options.retry ?? this.retryPolicy;
    let attempt = 1;
    for (;;) {
      try {
        return await this.driver.transaction(work);
      } catch (error) {
        if (!isRetryableDatabaseError(error) || attempt >= policy.maxAttempts) {
          throw error;
        }
        await this.sleepFn(backoffFor(attempt, policy));
        attempt += 1;
      }
    }
  }

  /**
   * The current transaction nesting depth (0 when no transaction is active).
   * Mirrors the driver's depth when the driver tracks it (the in-memory
   * driver exposes `transactionDepth`); drivers without depth tracking
   * report 0.
   */
  get depth(): number {
    const depth = (this.driver as { transactionDepth?: unknown }).transactionDepth;
    return typeof depth === "number" ? depth : 0;
  }

  /**
   * Optimistic-lock update: read the record, apply a pure data mutation,
   * bump the revision and CAS-write. Throws `OptimisticLockError` when the
   * record was modified concurrently and `DatabaseRecordNotFoundError` when
   * it does not exist. Returns the updated (frozen) record.
   */
  async withOptimisticLock<T = unknown>(
    handle: DatabaseTransactionHandle,
    scope: string,
    collection: DatabaseCollectionKind,
    recordId: string,
    update: OptimisticLockUpdate<T>,
  ): Promise<DatabaseRecord<T>> {
    const records = await handle.readAll(scope, collection);
    const current = records.find((record) => record.recordId === recordId);
    if (current === undefined) {
      throw new DatabaseRecordNotFoundError(scope, collection, recordId);
    }
    const data = update.mutateData === undefined ? current.data : update.mutateData(current.data as T);
    const successor = freezeDatabaseRecord(
      createDatabaseRecord({
        id: current.id,
        scope,
        collection,
        recordId,
        revision: current.revision + 1,
        version: current.version,
        archived: current.archived,
        archivedAt: current.archivedAt,
        deletedAt: current.deletedAt,
        createdAt: current.createdAt,
        updatedAt: update.now,
        data,
      }),
    );
    await handle.compareAndSwap(scope, collection, successor, current.revision);
    return successor as DatabaseRecord<T>;
  }
}

/** Exponential backoff with ceiling, capped by maxAttempts. */
export function backoffFor(attempt: number, policy: DatabaseRetryPolicy): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = policy.baseDelayMs * 2 ** exponent;
  return Math.min(raw, policy.maxDelayMs);
}

/** Default sleep: a promise that resolves after `ms` (dependency injectable). */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
