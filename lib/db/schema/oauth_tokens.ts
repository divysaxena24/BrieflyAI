import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { integrations } from "./integrations";

/**
 * OAuth tokens for connected platform integrations.
 * Stored separately from the integrations table for security isolation.
 * Tokens should be encrypted at the application level.
 */
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    integrationId: uuid("integration_id")
      .notNull()
      .unique()
      .references(() => integrations.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    tokenType: text("token_type").default("bearer"),
    scope: text("scope"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_oauth_tokens_integration_id").on(table.integrationId),
  ]
);
