"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { saveUserToDatabase } from "@/lib/auth";

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
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const fullName = String(formData.get("name") ?? "").trim();

  // --- Validation ---
  if (!email) return { error: "Email is required." };
  if (!password) return { error: "Password is required." };
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName || undefined,
      },
    },
  });

  if (error) {
    const msg = error.message;
    if (msg.includes("already registered") || msg.includes("already exists")) {
      return { error: "An account with this email already exists." };
    }
    if (msg.toLowerCase().includes("weak password")) {
      return { error: "Password is too weak. Please use a stronger password." };
    }
    return { error: msg };
  }

  if (!data.user) {
    return { error: "Could not create account. Please try again." };
  }

  // Save user to custom users table
  await saveUserToDatabase({
    authUserId: data.user.id,
    fullName: fullName || data.user.email?.split("@")[0] || "User",
    email: data.user.email ?? "",
    avatarUrl: null,
  });

  return {
    success: true,
    message:
      "Account created! Please check your email to verify your account. You can sign in immediately if email confirmation is disabled.",
  };
}

/**
 * Sign in with email & password.
 */
export async function signIn(
  _prev: unknown,
  formData: FormData,
): Promise<{ error?: string; success?: boolean }> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email) return { error: "Email is required." };
  if (!password) return { error: "Password is required." };

  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    const msg = error.message;
    if (
      msg.includes("Invalid login credentials") ||
      msg.includes("invalid email or password")
    ) {
      return { error: "Invalid email or password." };
    }
    return { error: msg };
  }

  // Save user to custom users table on first sign-in
  if (data.user) {
    const meta = data.user.user_metadata ?? {};
    await saveUserToDatabase({
      authUserId: data.user.id,
      fullName:
        (meta.full_name as string) ?? data.user.email?.split("@")[0] ?? "User",
      email: data.user.email ?? "",
      avatarUrl: (meta.avatar_url as string) ?? null,
    });
  }

  return { success: true };
}

/**
 * Sign out the current user and clear cookies.
 */
export async function signOut() {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);
  await supabase.auth.signOut();
  redirect("/");
}
