import { NextResponse } from "next/server";
import { checkDatabaseConnection } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * Health check endpoint for the BrieflyAI API.
 * Verifies application status and database connectivity.
 */
export async function GET() {
  let dbStatus = "disconnected";
  let dbError: string | null = null;

  try {
    const isConnected = await checkDatabaseConnection();
    dbStatus = isConnected ? "connected" : "error";
  } catch (err) {
    dbStatus = "error";
    dbError = err instanceof Error ? err.message : "Unknown error";
  }

  return NextResponse.json(
    {
      success: dbStatus === "connected",
      database: {
        status: dbStatus,
        ...(dbError && { error: dbError }),
      },
      environment: process.env.NODE_ENV ?? "development",
      timestamp: new Date().toISOString(),
    },
    { status: dbStatus === "connected" ? 200 : 503 }
  );
}
