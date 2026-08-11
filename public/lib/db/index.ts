import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// ─────────────────────────────────────────────
//  Database Schema Registry
//  All schema tables are re-exported from here
//  so consumers import from @/lib/db rather than
//  individual schema files.
// ─────────────────────────────────────────────

export * from "./schema/users";
export * from "./schema/integrations";
export * from "./schema/oauth_tokens";
export * from "./schema/activity_logs";
export * from "./schema/user_preferences";
export * from "./schema/briefings";
export * from "./schema/notifications";

// ─────────────────────────────────────────────
//  Drizzle ORM Client (singleton)
// ─────────────────────────────────────────────

const globalForDb = globalThis as unknown as { _dbClient?: ReturnType<typeof drizzle> };
const globalForSql = globalThis as unknown as { _sqlClient?: ReturnType<typeof postgres> };

function getClient() {
  if (!globalForDb._dbClient) {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error(
        "DATABASE_URL environment variable is not set. " +
          "Add it to .env.local to connect to the database."
      );
    }

    // Postgres.js connection with production defaults
    const sqlClient = postgres(connectionString, {
      max: 10, // Connection pool size
      idle_timeout: 20, // seconds
      connect_timeout: 10, // seconds
      max_lifetime: 60 * 30, // 30 minutes
      ssl: "require",
    });

    globalForSql._sqlClient = sqlClient;
    globalForDb._dbClient = drizzle(sqlClient, {
      logger: process.env.NODE_ENV === "development",
    });
  }
  return globalForDb._dbClient;
}

/**
 * Lazily resolved Drizzle ORM database client.
 *
 * Important for Next.js builds: route modules may be evaluated at build time
 * while collecting page data, before runtime-only environment variables like
 * `DATABASE_URL` are available inside the image. The proxy defers actual
 * client creation until the first real DB operation instead of at module load.
 */
export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, prop, receiver) {
    const client = getClient() as object;
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

/**
 * Raw SQL client for transactions and advanced queries.
 * Use sparingly — prefer the Drizzle ORM client for type safety.
 */
export function getSqlClient() {
  if (!globalForSql._sqlClient) {
    // Force client initialization if not already done
    getClient();
  }
  return globalForSql._sqlClient!;
}

/**
 * Health check: verifies database connectivity.
 * Returns `true` if the database responds, `false` otherwise.
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    const sql = getSqlClient();
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
