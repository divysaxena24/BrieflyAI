import { pgTable, uuid, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

/**
 * Serialized engine collections (Phase 5J STEP 3).
 *
 * The durable home of the in-memory engine state (memories, conversations,
 * jobs, digests, actions, workflows). One row per `(scope, collection)` —
 * the payload is the full serialized collection (JSON), so persistence is
 * atomic per collection and migration-safe via the schema `version`.
 *
 * `scope` namespaces the state (e.g. a user id or the "app" scope); the
 * engines themselves are per-process, so this table is the restart-recovery
 * source of truth.
 */
export const engineRecords = pgTable(
  "engine_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scope: text("scope").notNull(),
    collection: text("collection").notNull(),
    /** Codec schema version of the payload (forward-compatibility gate). */
    version: integer("version").notNull().default(1),
    /** Serialized engine records (JSON). */
    payload: text("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_engine_records_scope_collection").on(table.scope, table.collection),
    index("idx_engine_records_collection").on(table.collection),
  ],
);

