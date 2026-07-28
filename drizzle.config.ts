import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./lib/db/schema/*",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // Do not push to the auth schema; only manage the public schema
  schemaFilter: ["public"],
  verbose: true,
  strict: true,
});
