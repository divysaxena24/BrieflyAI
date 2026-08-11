-- Phase 6A STEP 3 — Production Database Layer.
-- Row-level storage of DatabaseRecord envelopes plus per-scope schema metadata.
--
-- NOTE: `engine_records` (Phase 5J) is re-declared here with IF NOT EXISTS so
-- this migration is idempotent for both fresh databases (where the manual
-- Phase 5J migration has not been journaled) and existing databases (where
-- the table already exists).

CREATE TABLE IF NOT EXISTS "engine_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"collection" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"payload" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "database_metadata" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "database_records" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"collection" text NOT NULL,
	"record_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_at" text,
	"deleted_at" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"payload" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_engine_records_scope_collection" ON "engine_records" USING btree ("scope","collection");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_engine_records_collection" ON "engine_records" USING btree ("collection");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_database_metadata_scope" ON "database_metadata" USING btree ("scope");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_database_records_scope_collection_record" ON "database_records" USING btree ("scope","collection","record_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_database_records_scope_collection" ON "database_records" USING btree ("scope","collection");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_database_records_updated_at" ON "database_records" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_database_records_archived" ON "database_records" USING btree ("archived");
