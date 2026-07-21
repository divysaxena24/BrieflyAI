CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "auth_user_id" uuid NOT NULL,
  "email" text NOT NULL,
  "full_name" text,
  "avatar_url" text,
  "provider" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "users_auth_user_id_unique" UNIQUE("auth_user_id"),
  CONSTRAINT "users_email_unique" UNIQUE("email")
);

--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_auth_user_id_auth_users_id_fk" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id") ON DELETE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_users_auth_user_id" ON "users" ("auth_user_id");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_users_email" ON "users" ("email");
