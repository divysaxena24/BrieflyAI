import { eq } from "drizzle-orm";
import { db, users } from "@/lib/db";

/**
 * Find a user by their Supabase auth_user_id.
 */
export async function findUserByAuthId(authUserId: string) {
  const result = await db
    .select()
    .from(users)
    .where(eq(users.authUserId, authUserId))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Find a user by their internal UUID.
 */
export async function findUserById(id: string) {
  const result = await db
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Find a user by their email address.
 */
export async function findUserByEmail(email: string) {
  const result = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Type for creating a new user.
 */
export interface CreateUserInput {
  authUserId: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  provider?: string;
}

/**
 * Create a new user record. No-op if the auth_user_id already exists.
 * Returns the created or existing user.
 */
export async function createUser(input: CreateUserInput) {
  const existing = await findUserByAuthId(input.authUserId);
  if (existing) return existing;

  const result = await db
    .insert(users)
    .values({
      authUserId: input.authUserId,
      email: input.email,
      fullName: input.fullName,
      avatarUrl: input.avatarUrl,
      provider: input.provider ?? "email",
    })
    .returning();

  return result[0];
}

/**
 * Update a user's profile fields.
 */
export async function updateUser(
  id: string,
  data: Partial<{
    fullName: string | null;
    avatarUrl: string | null;
    email: string;
  }>
) {
  const result = await db
    .update(users)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
  return result[0] ?? null;
}
