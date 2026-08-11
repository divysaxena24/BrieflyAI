import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users";
import { integrations } from "./integrations";

/**
 * Activity log for tracking all integration-related events.
 * Powers the activity timeline UI and audit trail.
 */
export const activityLogs = pgTable(
  "activity_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id").references(() => integrations.id, {
      onDelete: "set null",
    }),
    platform: text("platform"),
    action: text("action").notNull(),
    details: text("details"),
    metadata: text("metadata"), // JSON string for extra context
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_activity_logs_user_id").on(table.userId),
    index("idx_activity_logs_integration_id").on(table.integrationId),
    index("idx_activity_logs_created_at").on(table.createdAt),
    index("idx_activity_logs_user_created").on(table.userId, table.createdAt),
  ]
);
