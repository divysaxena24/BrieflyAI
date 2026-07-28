import { pgSchema, pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Reference to Supabase Auth users table (auth schema).
 * Required for FK constraint — drizzle-kit won't manage this table
 * because schemaFilter is set to ["public"].
 */
export const authUsers = pgSchema("auth").table("users", {
  id: uuid("id").primaryKey(),
});

/**
 * Application-level users table.
 * Mirrors Supabase Auth users with additional profile fields.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    authUserId: uuid("auth_user_id")
      .notNull()
      .unique()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    email: text("email").notNull().unique(),
    fullName: text("full_name"),
    avatarUrl: text("avatar_url"),
    provider: text("provider"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_users_auth_user_id").on(table.authUserId),
    index("idx_users_email").on(table.email),
  ]
);
