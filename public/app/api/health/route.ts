import { withHandler } from "@/lib/api/handler";
import { checkDatabaseConnection } from "@/lib/db";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export const GET = withHandler(async () => {
  logger.debug("GET /api/health - handler");
  let dbStatus = "disconnected";
  try {
    const isConnected = await checkDatabaseConnection();
    dbStatus = isConnected ? "connected" : "error";
  } catch (err) {
    dbStatus = "error";
  }

  const payload = {
    database: { status: dbStatus },
    environment: process.env.NODE_ENV ?? "development",
    timestamp: new Date().toISOString(),
  };

  logger.info("Health check", { dbStatus });
  return { message: dbStatus === "connected" ? "ok" : "db_error", data: payload };
});
