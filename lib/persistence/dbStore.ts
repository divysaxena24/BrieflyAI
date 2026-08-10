/**
 * Persistence layer — Postgres store (Phase 5J STEP 3).
 *
 * `PostgresPersistenceStore` implements the `PersistenceStore` contract over
 * the existing Drizzle setup (`lib/db`): one row per `(scope, collection)`
 * in the new `engine_records` table, with the payload stored as JSON text.
 * Writes are full-snapshot upserts; reads return detached collections.
 *
 * The store is the durable production store of the persistence layer. The
 * `PersistenceEngine` composition root accepts any `PersistenceStore`, so
 * the application wires this store where a database is available and the
 * in-memory store otherwise (dependency injection — the engines never know
 * which store backs them).
 *
 * NOTE: this module imports `@/lib/db`, which requires `DATABASE_URL` at
 * module load. Tests therefore exercise the persistence contract against
 * the in-memory store; this store is wired by the application, not by tests.
 */

import { db } from "@/lib/db";
import { engineRecords } from "@/lib/db/schema/engine_records";
import { eq, and } from "drizzle-orm";
import { createStoredCollection, type CollectionKind, type PersistenceStore, type StoredCollection } from "./types";

/**
 * Postgres-backed persistence store over the Drizzle singleton.
 * Lazy by construction — no query runs until a method is called.
 */
export class PostgresPersistenceStore implements PersistenceStore {
  /** Read the stored collection for `(scope, kind)`, or `undefined`. */
  async read(scope: string, kind: CollectionKind): Promise<StoredCollection | undefined> {
    const rows = await db
      .select()
      .from(engineRecords)
      .where(and(eq(engineRecords.scope, scope), eq(engineRecords.collection, kind)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return undefined;
    return createStoredCollection({
      scope: row.scope,
      kind: row.collection as CollectionKind,
      version: row.version,
      payload: row.payload,
    });
  }

  /** Upsert the full serialized collection for `(scope, kind)`. */
  async write(scope: string, kind: CollectionKind, collection: StoredCollection): Promise<void> {
    await db
      .insert(engineRecords)
      .values({
        scope,
        collection: kind,
        version: collection.version,
        payload: collection.payload,
      })
      .onConflictDoUpdate({
        target: [engineRecords.scope, engineRecords.collection],
        set: {
          version: collection.version,
          payload: collection.payload,
          updatedAt: new Date(),
        },
      });
  }

  /** Remove the stored collection for `(scope, kind)`. Never throws. */
  async clear(scope: string, kind: CollectionKind): Promise<void> {
    await db
      .delete(engineRecords)
      .where(and(eq(engineRecords.scope, scope), eq(engineRecords.collection, kind)));
  }
}

/** Build a fresh Postgres-backed persistence store. */
export function createPostgresPersistenceStore(): PostgresPersistenceStore {
  return new PostgresPersistenceStore();
}
