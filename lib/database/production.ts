/**
 * Production Database Layer — production wiring (Phase 6A STEP 9).
 *
 * `DatabaseEngine` is the composition root of the database layer. It binds:
 *
 * - the `DatabaseDriver` (in-memory by default — deterministic, no database
 *   required; applications with Postgres wire `createPostgresDatabaseDriver`
 *   from `./postgresDriver`);
 * - the `DatabasePersistence` (row-level incremental save/restore over the
 *   Phase 5J adapters/codecs);
 * - per-collection `DatabaseRepository` adapters (CRUD, optimistic locking,
 *   pagination, search, transactions);
 * - the `RetentionEngine` (cleanup preview/execution + statistics);
 * - a `DatabaseTransactionManager` for application-level transactions.
 *
 * The Phase 5A–5I production engines are NOT re-composed here — they remain
 * owned by their own composition roots (`getProductionMemoryEngine`, …).
 * This layer provides the *database* seam they can persist through.
 *
 * Everything is dependency-injected; the module singleton is read-only
 * after construction.
 */

import { MemoryDatabaseDriver } from "@/lib/database/memoryDriver";
import { DatabasePersistence, type DatabaseEngineSet } from "@/lib/database/persistence";
import { RetentionEngine, createRetentionEngine, type DatabaseOrphanPredicate } from "@/lib/database/retention";
import { DatabaseTransactionManager } from "@/lib/database/transaction";
import { DatabaseRepository } from "@/lib/database/repository";
import type { DatabaseDriver } from "@/lib/database/driver";
import type { DatabaseCollectionKind } from "@/lib/database/types";
import type { DatabaseRetention } from "@/lib/database/types";

/** Options accepted by the {@link DatabaseEngine} constructor. */
export interface DatabaseEngineOptions {
  /** The storage driver (dependency injection; in-memory by default). */
  readonly driver?: DatabaseDriver;
  /** Retention policies (dependency injection). */
  readonly policies?: readonly DatabaseRetention[];
  /** Orphan predicate for orphan-cleanup policies. */
  readonly isOrphan?: DatabaseOrphanPredicate;
}

/** The database composition root. */
export class DatabaseEngine {
  /** The storage driver. */
  readonly driver: DatabaseDriver;
  /** Row-level persistence over the Phase 5J adapters. */
  readonly persistence: DatabasePersistence;
  /** The retention engine. */
  readonly retention: RetentionEngine;
  /** Application-level transaction manager. */
  readonly transactions: DatabaseTransactionManager;

  private readonly repositories: ReadonlyMap<DatabaseCollectionKind, DatabaseRepository>;

  constructor(options: DatabaseEngineOptions = {}) {
    this.driver = options.driver ?? new MemoryDatabaseDriver();
    this.persistence = new DatabasePersistence({ driver: this.driver });
    this.retention = createRetentionEngine({
      driver: this.driver,
      policies: options.policies,
      isOrphan: options.isOrphan,
    });
    this.transactions = new DatabaseTransactionManager({ driver: this.driver });
    const map = new Map<DatabaseCollectionKind, DatabaseRepository>();
    for (const kind of DATABASE_ENGINE_COLLECTIONS) {
      map.set(kind, new DatabaseRepository({ driver: this.driver, scope: DEFAULT_DATABASE_SCOPE, collection: kind }));
    }
    this.repositories = map;
  }

  /** The repository for a collection (bound to the default scope). */
  repository(collection: DatabaseCollectionKind): DatabaseRepository {
    const repo = this.repositories.get(collection);
    if (repo === undefined) throw new Error(`No repository for collection "${collection}"`);
    return repo;
  }

  /** A repository bound to an explicit scope (per-user namespacing). */
  scoped(scope: string, collection: DatabaseCollectionKind): DatabaseRepository {
    return new DatabaseRepository({ driver: this.driver, scope, collection });
  }

  /** Persist a full engine set (incremental, failure-isolated). */
  async saveAll(scope: string, engines: DatabaseEngineSet, now: string) {
    return this.persistence.saveAll(scope, engines, now);
  }

  /** Rebuild a fresh engine set from storage (restart recovery). */
  async restoreAll(scope: string) {
    return this.persistence.restoreAll(scope);
  }
}

/** The default database scope used by the module singleton ("app"). */
export const DEFAULT_DATABASE_SCOPE = "app";

/** Every collection the database engine exposes repositories for. */
export const DATABASE_ENGINE_COLLECTIONS: readonly DatabaseCollectionKind[] = Object.freeze([
  "memory",
  "conversation",
  "job",
  "digest",
  "action",
  "workflow",
  "event",
  "metadata",
]);

/**
 * Build a fresh production database engine.
 *
 * Optional `driver`/`policies`/`isOrphan` seed the graph (dependency
 * injection). Pure — construction only; nothing is read or written. With no
 * driver, the deterministic in-memory driver is used.
 */
export function createProductionDatabase(options: DatabaseEngineOptions = {}): DatabaseEngine {
  return new DatabaseEngine(options);
}

/**
 * The application's single production database engine instance.
 * In-memory driver by default (deterministic, no database required).
 */
const productionDatabase = createProductionDatabase();

/** Return the application's single production database engine instance. */
export function getProductionDatabase(): DatabaseEngine {
  return productionDatabase;
}

/**
 * Whether the production database is backed by Postgres. Detected by the
 * driver's `backing` marker so this module never statically imports the
 * Postgres driver (which loads `@/lib/db` and requires `DATABASE_URL` — the
 * 5J convention: the DB module is wired by the application, not by unit
 * tests).
 */
export function isPostgresBacked(): boolean {
  return productionDatabase.driver.backing === "postgres";
}

/**
 * Rebuild the production database over a Postgres driver (app bootstrap).
 * The Postgres driver is loaded lazily so importing this module never
 * requires `DATABASE_URL`.
 */
export async function createPostgresBackedDatabase(): Promise<DatabaseEngine> {
  const { createPostgresDatabaseDriver } = await import("@/lib/database/postgresDriver");
  return createProductionDatabase({ driver: createPostgresDatabaseDriver() });
}
