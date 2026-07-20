"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createAuthActions, createServerClient } from "@insforge/sdk/ssr";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Save the user profile on first sign-in. No-op if already exists. */
async function saveProfileOnFirstSignIn(userId: string, nickname?: string) {
  try {
    const insforge = createServerClient({ cookies: await cookies() });
    const { data: profile } = await insforge.auth.getProfile(userId);
    if (!profile) {
      await insforge.auth.setProfile({
        nickname: nickname ?? "User",
      });
    }
  } catch {
    // Non-critical
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Sign up with email & password.
 */
export async function signUp(
  _prev: unknown,
  formData: FormData,
): Promise<{ error?: string; success?: boolean; message?: string }> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const name = String(formData.get("name") ?? "");

  const auth = createAuthActions({ cookies: await cookies() });
  const { data, error } = await auth.signUp({
    email,
    password,
    name: name || undefined,
    redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/sign-in`,
  });

  if (error) {
    return { error: error.message };
  }

  return {
    success: true,
    message: "Account created! Please check your email to verify your account.",
  };
}

/**
 * Sign in with email & password.
 */
export async function signIn(
  _prev: unknown,
  formData: FormData,
): Promise<{ error?: string; success?: boolean }> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const auth = createAuthActions({ cookies: await cookies() });
  const { data, error } = await auth.signInWithPassword({ email, password });

  if (error) {
    return { error: error.message };
  }

  // Save profile on first sign-in
  if (data?.user?.id) {
    await saveProfileOnFirstSignIn(data.user.id, (data.user as Record<string, unknown>).name as string | undefined);
  }

  return { success: true };
}

/**
 * Initiate Google OAuth sign-in.
 * Stores codeVerifier in a cookie for the callback route to use.
 */
export async function signInWithGoogle(): Promise<{ url?: string; error?: string }> {
  const cookieStore = await cookies();
  const auth = createAuthActions({ cookies: cookieStore });
  const { data, error } = await auth.signInWithOAuth("google", {
    redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
    skipBrowserRedirect: true,
  });

  if (error) {
    return { error: error.message };
  }

  // Store codeVerifier so the callback can exchange it
  const codeVerifier = (data as Record<string, unknown>).codeVerifier as string | undefined;
  if (codeVerifier) {
    cookieStore.set("insforge_code_verifier", codeVerifier, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 5, // 5 minutes
    });
  }

  return { url: data?.url };
}

/**
 * Sign out the current user and clear cookies.
 */
export async function signOut() {
  const auth = createAuthActions({ cookies: await cookies() });
  await auth.signOut();
  redirect("/");
}
