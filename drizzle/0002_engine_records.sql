-- Phase 5J STEP 3 — Persistence & Application Integration.
-- Durable home of the in-memory engine state: one row per (scope, collection).
-- The payload is the full serialized collection (JSON); `version` is the
-- codec schema version (migration-safe forward-compatibility gate).

CREATE TABLE IF NOT EXISTS "engine_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scope" text NOT NULL,
  "collection" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "payload" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_engine_records_scope_collection"
  ON "engine_records" ("scope", "collection");

CREATE INDEX IF NOT EXISTS "idx_engine_records_collection"
  ON "engine_records" ("collection");
