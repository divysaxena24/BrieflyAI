import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Connected platform integrations.
 * Stores OAuth credentials, connection status, and sync metadata
 * for each third-party platform connected by a user.
 */
export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    status: text("status").notNull().default("not-connected"),
    permissions: text("permissions").notNull().default("read"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    syncStatus: text("sync_status").default("idle"),
    syncError: text("sync_error"),
    accountEmail: text("account_email"),
    accountName: text("account_name"),
    metadata: text("metadata"), // JSON string for platform-specific data
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_integrations_user_id").on(table.userId),
    index("idx_integrations_platform").on(table.platform),
    index("idx_integrations_user_platform").on(table.userId, table.platform),
    uniqueIndex("uq_integrations_user_platform").on(table.userId, table.platform),
  ]
);
