import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * AI-generated daily/weekly briefings.
 * Stores summaries, digests, and AI-produced content for each user.
 */
export const briefings = pgTable(
  "briefings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    type: text("type").notNull().default("daily"),
    summary: text("summary").notNull(),
    sourcePlatforms: text("source_platforms"), // Comma-separated platform IDs
    metadata: text("metadata"), // JSON string
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_briefings_user_id").on(table.userId),
    index("idx_briefings_created_at").on(table.createdAt),
    index("idx_briefings_user_created").on(table.userId, table.createdAt),
  ]
);
