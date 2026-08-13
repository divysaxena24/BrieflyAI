/**
 * Settings center — server-side service.
 *
 * Single place that reads/writes the user's profile and preferences
 * (`user_preferences` table) and performs the privacy actions (export,
 * clear chat history, delete account). API routes stay thin and delegate here.
 */

import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { createClient } from "@/utils/supabase/server";
import { db, users } from "@/lib/db";
import {
  findUserById,
  getUserPreferences,
  upsertUserPreferences,
} from "@/lib/db/queries";
import { getEngineApi } from "@/lib/api/resources";
import type {
  SettingsData,
  SettingsPreferences,
  SettingsUser,
} from "./types";

/** Defaults applied for any preference the user has never touched. */
export const DEFAULT_PREFERENCES: SettingsPreferences = {
  theme: "system",
  responseStyle: "balanced",
  preferredLanguage: "english",
  aiMemory: true,
  compactMode: false,
};

/** The user's plan — billing is not implemented yet, so every account is Free. */
export const DEFAULT_PLAN = "free";

/** Parse the `metadata` jsonb column defensively. */
function parseMetadata(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object") return {};
  return raw as Record<string, unknown>;
}

/** Merge stored preferences over the defaults. */
export function mergePreferences(stored: {
  theme?: string | null;
  metadata?: unknown;
}): SettingsPreferences {
  const meta = parseMetadata(stored.metadata);
  return {
    theme: isThemeMode(stored.theme) ? stored.theme : DEFAULT_PREFERENCES.theme,
    responseStyle: isResponseStyle(meta.responseStyle)
      ? meta.responseStyle
      : DEFAULT_PREFERENCES.responseStyle,
    preferredLanguage: isPreferredLanguage(meta.preferredLanguage)
      ? meta.preferredLanguage
      : DEFAULT_PREFERENCES.preferredLanguage,
    aiMemory:
      typeof meta.aiMemory === "boolean"
        ? meta.aiMemory
        : DEFAULT_PREFERENCES.aiMemory,
    compactMode:
      typeof meta.compactMode === "boolean"
        ? meta.compactMode
        : DEFAULT_PREFERENCES.compactMode,
  };
}

function isThemeMode(value: unknown): value is SettingsPreferences["theme"] {
  return value === "light" || value === "dark" || value === "system";
}
function isResponseStyle(value: unknown): value is SettingsPreferences["responseStyle"] {
  return value === "concise" || value === "balanced" || value === "detailed";
}
function isPreferredLanguage(value: unknown): value is SettingsPreferences["preferredLanguage"] {
  return value === "english" || value === "hindi";
}

/** Load the settings payload for a user (internal users.id). */
export async function getSettings(userId: string): Promise<SettingsData> {
  const user = await findUserById(userId);
  const preferences = await getUserPreferences(userId);

  const settingsUser: SettingsUser = {
    id: user?.id ?? userId,
    email: user?.email ?? "",
    fullName: user?.fullName ?? null,
    avatarUrl: user?.avatarUrl ?? null,
    createdAt: user?.createdAt ? user.createdAt.toISOString() : "",
  };

  return {
    user: settingsUser,
    plan: DEFAULT_PLAN,
    preferences: mergePreferences({
      theme: preferences?.theme,
      metadata: preferences?.metadata,
    }),
  };
}

/** Persist a preferences patch and return the merged result. */
export async function updatePreferences(
  userId: string,
  patch: Partial<SettingsPreferences>,
): Promise<SettingsPreferences> {
  const current = await getUserPreferences(userId);
  const merged = mergePreferences({
    theme: current?.theme,
    metadata: current?.metadata,
  });
  const next: SettingsPreferences = { ...merged, ...patch };

  await upsertUserPreferences(userId, {
    theme: next.theme,
    metadata: {
      responseStyle: next.responseStyle,
      preferredLanguage: next.preferredLanguage,
      aiMemory: next.aiMemory,
      compactMode: next.compactMode,
    },
  });
  return next;
}

/** Update the profile name in the users table and the Supabase auth metadata. */
export async function updateProfile(
  userId: string,
  input: { fullName: string },
): Promise<SettingsUser> {
  const fullName = input.fullName.trim();
  if (!fullName) throw new Error("Name cannot be empty");

  const updated = await db
    .update(users)
    .set({ fullName, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();

  // Keep Supabase auth metadata in sync so the name survives re-auth.
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    await supabase.auth.updateUser({ data: { full_name: fullName } });
  } catch {
    // Non-critical — the users table is the source of truth for the UI.
  }

  const row = updated[0];
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Clear all conversations in the engine and return how many were removed. */
export async function clearChatHistory(): Promise<number> {
  const api = getEngineApi();
  const conversations = api.listConversations();
  for (const conversation of conversations) {
    api.deleteConversation(conversation.id);
  }
  return conversations.length;
}

/** Full data export: profile, preferences, and conversations. */
export async function exportSettingsData(userId: string): Promise<Record<string, unknown>> {
  const settings = await getSettings(userId);
  return {
    exportedAt: new Date().toISOString(),
    profile: settings.user,
    plan: settings.plan,
    preferences: settings.preferences,
    conversations: getEngineApi().listConversations(),
  };
}

/**
 * Delete the account and all of its data.
 *
 * Deleting the `users` row cascades to `user_preferences`, `integrations`
 * (and their `oauth_tokens`) and `activity_logs` via foreign keys, then the
 * in-memory conversation engine is cleared. The Supabase auth account itself
 * is not touched here — that requires the service-role admin API which this
 * app intentionally does not expose to route handlers.
 */
export async function deleteAccount(userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
  await clearChatHistory();
}
