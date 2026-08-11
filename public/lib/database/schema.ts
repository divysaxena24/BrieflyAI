/**
 * Production Database Layer — Drizzle schema (Phase 6A STEP 3).
 *
 * The relational home of the database layer's `DatabaseRecord` envelopes:
 * one row per record in `database_records`, plus `database_metadata` for
 * per-scope schema-version bookkeeping (migration-safe storage).
 *
 * Design notes:
 * - The existing `engine_records` table (Phase 5J) persists *whole serialized
 *   collections*; `database_records` is the row-level store the Phase 6A
 *   repository layer writes through its driver. Both coexist — 5J is the
 *   application persistence engine, 6A is the production database layer.
 * - Column names mirror the `DatabaseRecord` envelope (revision, version,
 *   archived, archivedAt, deletedAt, timestamps); `payload` holds the JSON
 *   of `data`.
 * - Indexes cover the hot query paths: (scope, collection, recordId) unique,
 *   (scope, collection) for collection scans, updatedAt for recency sorts,
 *   and archived for lifecycle filtering.
 * - No foreign keys are declared: the `engine_records` table has none, and
 *   records are owned by callers' `scope` (opaque text), not by a users
 *   table this layer may not control. Referential integrity is enforced by
 *   the repository layer (ids are checked before writes).
 *
 * Authentication tables (`lib/db/schema/users.ts` and friends) are NOT
 * modified.
 */

import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Row-level storage of `DatabaseRecord` envelopes. One row per
 * `(scope, collection, recordId)`; `payload` is the JSON-serialized `data`.
 */
export const databaseRecords = pgTable(
  "database_records",
  {
    /** Deterministic row id: `record-<hash(scope:collection:recordId)>`. */
    id: text("id").primaryKey(),
    /** Caller-supplied namespace (e.g. a user id or "app"). */
    scope: text("scope").notNull(),
    /** Which collection the record belongs to. */
    collection: text("collection").notNull(),
    /** The engine record's own id (stable across re-writes). */
    recordId: text("record_id").notNull(),
    /** Optimistic-lock revision; bumped on every write. */
    revision: integer("revision").notNull().default(1),
    /** Schema/codec version of the payload. */
    version: integer("version").notNull().default(1),
    /** Whether the record is archived. */
    archived: boolean("archived").notNull().default(false),
    /** ISO-8601 UTC timestamp of archival (JSON-encoded text). */
    archivedAt: text("archived_at"),
    /** ISO-8601 UTC timestamp of soft deletion. */
    deletedAt: text("deleted_at"),
    /** ISO-8601 UTC timestamp of creation. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    /** ISO-8601 UTC timestamp of the most recent modification. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    /** The engine record payload (JSON). */
    payload: text("payload").notNull(),
  },
  (table) => [
    uniqueIndex("idx_database_records_scope_collection_record").on(
      table.scope,
      table.collection,
      table.recordId,
    ),
    index("idx_database_records_scope_collection").on(table.scope, table.collection),
    index("idx_database_records_updated_at").on(table.updatedAt),
    index("idx_database_records_archived").on(table.archived),
  ],
);

/**
 * Per-scope schema-version bookkeeping (migration-safe storage). One row per
 * scope; `schemaVersion` is the version the scope's data was written with.
 */
export const databaseMetadata = pgTable(
  "database_metadata",
  {
    /** Deterministic metadata id derived from the scope. */
    id: text("id").primaryKey(),
    /** Caller-supplied namespace. */
    scope: text("scope").notNull(),
    /** The schema version the scope's data was written with. */
    schemaVersion: integer("schema_version").notNull().default(1),
    /** ISO-8601 UTC timestamp of creation. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    /** ISO-8601 UTC timestamp of the most recent update. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex("idx_database_metadata_scope").on(table.scope)],
);
