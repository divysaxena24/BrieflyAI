-- ============================================================================
-- Row Level Security Policies for "users" table
-- ============================================================================
-- Run this AFTER the table is created.
-- These policies ensure authenticated users can only access their own records.
-- ============================================================================

-- Enable RLS on the users table (idempotent)
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

-- Policy: Users can read only their own profile
CREATE POLICY "users_read_own" ON "users"
  FOR SELECT
  USING (auth_user_id = auth.uid());

--> statement-breakpoint

-- Policy: Users can insert only their own profile (first sign-up)
CREATE POLICY "users_insert_own" ON "users"
  FOR INSERT
  WITH CHECK (auth_user_id = auth.uid());

--> statement-breakpoint

-- Policy: Users can update only their own profile
CREATE POLICY "users_update_own" ON "users"
  FOR UPDATE
  USING (auth_user_id = auth.uid())
  WITH CHECK (auth_user_id = auth.uid());

--> statement-breakpoint

-- Policy: Users can delete only their own profile
CREATE POLICY "users_delete_own" ON "users"
  FOR DELETE
  USING (auth_user_id = auth.uid());
