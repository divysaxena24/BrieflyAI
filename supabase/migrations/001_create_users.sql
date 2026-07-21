-- Create users table for storing application-level user data.
-- This mirrors Supabase Auth users and allows additional fields.
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id UUID UNIQUE NOT NULL,
  email TEXT NOT NULL,
  full_name TEXT,
  avatar_url TEXT,
  provider TEXT NOT NULL DEFAULT 'email',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast lookups by auth_user_id (used in saveUserToDatabase)
CREATE INDEX IF NOT EXISTS idx_users_auth_user_id ON public.users (auth_user_id);

-- Index for email lookups
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users (email);

-- Enable Row Level Security
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Policy: users can read their own record
CREATE POLICY "Users can read own record"
  ON public.users
  FOR SELECT
  USING (auth_user_id = auth.uid());

-- Policy: users can insert their own record (first sign-up)
CREATE POLICY "Users can insert own record"
  ON public.users
  FOR INSERT
  WITH CHECK (auth_user_id = auth.uid());

-- Policy: users can update their own record
CREATE POLICY "Users can update own record"
  ON public.users
  FOR UPDATE
  USING (auth_user_id = auth.uid());
