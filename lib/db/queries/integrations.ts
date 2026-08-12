import { eq, and, desc, sql } from "drizzle-orm";
import { db, integrations, oauthTokens } from "@/lib/db";

/**
 * Get all integrations for a user.
 */
export async function getUserIntegrations(userId: string) {
  return db
    .select()
    .from(integrations)
    .where(eq(integrations.userId, userId))
    .orderBy(integrations.createdAt);
}

/**
 * Get a specific integration by ID (scoped to user).
 */
export async function getIntegrationById(id: string, userId: string) {
  const result = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, id), eq(integrations.userId, userId)))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Get a user's integration for a specific platform.
 */
export async function getUserIntegrationByPlatform(userId: string, platform: string) {
  const result = await db
    .select()
    .from(integrations)
    .where(
      and(eq(integrations.userId, userId), eq(integrations.platform, platform))
    )
    .orderBy(
      sql<number>`CASE WHEN ${integrations.status} = 'connected' THEN 0 ELSE 1 END`,
      desc(integrations.updatedAt),
      desc(integrations.createdAt),
    )
    .limit(1);
  return result[0] ?? null;
}

/**
 * Get full connected account info including OAuth scopes for a specific platform.
 * Joins integrations with oauth_tokens to provide email, name, avatar, scopes, permissions.
 * Returns null if no integration exists for the given user + platform.
 */
export async function getConnectedAccount(userId: string, platform: string) {
  const result = await db
    .select({
      id: integrations.id,
      userId: integrations.userId,
      platform: integrations.platform,
      status: integrations.status,
      permissions: integrations.permissions,
      accountEmail: integrations.accountEmail,
      accountName: integrations.accountName,
      metadata: integrations.metadata,
      lastSyncAt: integrations.lastSyncAt,
      syncStatus: integrations.syncStatus,
      createdAt: integrations.createdAt,
      updatedAt: integrations.updatedAt,
      scopes: oauthTokens.scope,
      expiresAt: oauthTokens.expiresAt,
    })
    .from(integrations)
    .leftJoin(oauthTokens, eq(oauthTokens.integrationId, integrations.id))
    .where(
      and(eq(integrations.userId, userId), eq(integrations.platform, platform))
    )
    // If legacy duplicate rows exist, never return an arbitrary one — prefer
    // the connected row, then the most recently updated row.
    .orderBy(
      sql<number>`CASE WHEN ${integrations.status} = 'connected' THEN 0 ELSE 1 END`,
      desc(integrations.updatedAt),
      desc(integrations.createdAt),
    )
    .limit(1);
  return result[0] ?? null;
}

/**
 * Return type for getConnectedAccount.
 */
export type ConnectedAccount = Awaited<ReturnType<typeof getConnectedAccount>>;

/**
 * Type for creating a new integration.
 */
export interface CreateIntegrationInput {
  userId: string;
  platform: string;
  permissions?: string;
  accountEmail?: string;
  accountName?: string;
  metadata?: string;
}

/**
 * Create a new integration record.
 */
export async function createIntegration(input: CreateIntegrationInput) {
  const result = await db
    .insert(integrations)
    .values({
      userId: input.userId,
      platform: input.platform,
      permissions: input.permissions ?? "read",
      accountEmail: input.accountEmail,
      accountName: input.accountName,
      metadata: input.metadata,
    })
    .onConflictDoUpdate({
      target: [integrations.userId, integrations.platform],
      set: {
        permissions: input.permissions ?? "read",
        accountEmail: input.accountEmail,
        accountName: input.accountName,
        metadata: input.metadata,
        updatedAt: new Date(),
      },
    })
    .returning();
  return result[0];
}

/**
 * Update an integration's status.
 */
export async function updateIntegrationStatus(
  id: string,
  status: string,
  syncStatus?: string
) {
  const result = await db
    .update(integrations)
    .set({
      status,
      syncStatus: syncStatus ?? "idle",
      lastSyncAt: status === "connected" ? new Date() : undefined,
      updatedAt: new Date(),
    })
    .where(eq(integrations.id, id))
    .returning();
  return result[0] ?? null;
}

/**
 * Delete an integration.
 */
export async function deleteIntegration(id: string, userId: string) {
  const result = await db
    .delete(integrations)
    .where(and(eq(integrations.id, id), eq(integrations.userId, userId)))
    .returning();
  return result[0] ?? null;
}
