import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createUser } from "@/lib/db/queries";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthUser = {
  id: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
};

// ---------------------------------------------------------------------------
// Server-side helpers
// ---------------------------------------------------------------------------

/** Create a Supabase client pre-configured with the request cookies. */
async function createServerSupabaseClient() {
  const cookieStore = await cookies();
  return createClient(cookieStore);
}

/**
 * Retrieve the currently authenticated user from the Supabase session.
 * Returns `null` when not authenticated.
 *
 * Use in Server Components, Server Actions, and Route Handlers.
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    const supabase = await createServerSupabaseClient();
    const { data } = await supabase.auth.getUser();
    if (!data?.user) return null;

    const meta = data.user.user_metadata ?? {};

    return {
      id: data.user.id,
      email: data.user.email ?? "",
      fullName: (meta.full_name as string) ?? data.user.email?.split("@")[0] ?? null,
      avatarUrl: (meta.avatar_url as string) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Retrieve the currently authenticated user or redirect to sign-in.
 *
 * Use in Server Components that require authentication.
 */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  return user;
}

/**
 * Get the current Supabase session.
 */
export async function getSession() {
  const supabase = await createServerSupabaseClient();
  return supabase.auth.getSession();
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/**
 * Save a user to the custom `users` table after their first successful login.
 * Uses Drizzle ORM via the query layer.
 * No-op if a record with the same `auth_user_id` already exists.
 */
export async function saveUserToDatabase(user: {
  authUserId: string;
  fullName: string;
  email: string;
  avatarUrl: string | null;
  /** Auth provider that created this user. Defaults to "email". */
  provider?: string;
}): Promise<void> {
  try {
    await createUser({
      authUserId: user.authUserId,
      email: user.email,
      fullName: user.fullName,
      avatarUrl: user.avatarUrl,
      provider: user.provider ?? "email",
    });
  } catch {
    // Non-critical – the Supabase session is already established
  }
}
