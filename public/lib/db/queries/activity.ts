import { eq, desc } from "drizzle-orm";
import { db, activityLogs } from "@/lib/db";

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface LogActivityInput {
  userId: string;
  platform: string;
  action: string;
  details?: string | null;
  integrationId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ActivityLogEntry {
  id: string;
  userId: string;
  platform: string | null;
  action: string;
  details: string | null;
  metadata: string | null;
  createdAt: Date;
}

// ──────────────────────────────────────────────
//  Helper: Log an activity event
// ──────────────────────────────────────────────

/**
 * Log an integration-related activity event to the database.
 * Call this from every service/handler that performs a meaningful
 * integration action (connect, disconnect, search, read, etc.).
 */
export async function logActivity(input: LogActivityInput): Promise<ActivityLogEntry> {
  const result = await db
    .insert(activityLogs)
    .values({
      userId: input.userId,
      platform: input.platform,
      action: input.action,
      details: input.details ?? null,
      integrationId: input.integrationId ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    })
    .returning();
  return result[0];
}

// ──────────────────────────────────────────────
//  Query: Get recent activity for a user
// ──────────────────────────────────────────────

export interface GetActivityOptions {
  userId: string;
  limit?: number;
}

/**
 * Fetch recent activity logs for a user, newest first.
 * Used by the dashboard Recent Activity timeline.
 */
export async function getActivityLogs(options: GetActivityOptions): Promise<ActivityLogEntry[]> {
  const limit = options.limit ?? 10;

  return db
    .select()
    .from(activityLogs)
    .where(eq(activityLogs.userId, options.userId))
    .orderBy(desc(activityLogs.createdAt))
    .limit(limit);
}
