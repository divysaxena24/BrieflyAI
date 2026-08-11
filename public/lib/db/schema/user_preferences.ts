import { pgTable, uuid, text, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Per-user application preferences.
 * Stores theme, notification, and feature toggles.
 */
export const userPreferences = pgTable(
  "user_preferences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    theme: text("theme").default("system"),
    notificationsEnabled: boolean("notifications_enabled").default(true),
    emailDigest: boolean("email_digest").default(false),
    digestFrequency: text("digest_frequency").default("daily"),
    timezone: text("timezone").default("UTC"),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  }
);
