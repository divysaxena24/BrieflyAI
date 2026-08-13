import { eq } from "drizzle-orm";
import { db, userPreferences } from "@/lib/db";

/** Look up a user's preferences row by the internal user id. */
export async function getUserPreferences(userId: string) {
  const rows = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

/** The shape accepted by the preferences upsert. */
export interface UpsertUserPreferencesInput {
  theme?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Insert a preferences row on first use, otherwise merge the update into the
 * existing row (theme column + metadata JSON object are merged field-wise).
 */
export async function upsertUserPreferences(
  userId: string,
  input: UpsertUserPreferencesInput,
) {
  const existing = await getUserPreferences(userId);

  const values = {
    theme: input.theme ?? existing?.theme ?? "system",
    metadata: {
      ...(existing?.metadata ?? {}),
      ...(input.metadata ?? {}),
    },
  };

  if (existing) {
    const result = await db
      .update(userPreferences)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(userPreferences.userId, userId))
      .returning();
    return result[0] ?? null;
  }

  const result = await db
    .insert(userPreferences)
    .values({ userId, ...values })
    .returning();
  return result[0] ?? null;
}
