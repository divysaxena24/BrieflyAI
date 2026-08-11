import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { getActivityLogs, findUserByAuthId } from "@/lib/db/queries";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  logger.debug("GET /api/activity - handler");

  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    const { data: userData } = await supabase.auth.getUser();
    const authUserId = userData?.user?.id;
    if (!authUserId) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const appUser = await findUserByAuthId(authUserId);
    if (!appUser) {
      return NextResponse.json({ message: "User not found" }, { status: 404 });
    }

    const activities = await getActivityLogs({ userId: appUser.id, limit: 10 });

    // Map to the frontend-friendly shape
    const data = activities.map((a) => ({
      id: a.id,
      platformId: a.platform ?? "unknown",
      action: a.action,
      details: a.details,
      type: inferActivityType(a.action),
      createdAt: a.createdAt.toISOString(),
    }));

    return NextResponse.json({ data });
  } catch (err) {
    logger.error("GET /api/activity failed", { error: String(err) });
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }
}

/**
 * Map an activity action string to a timeline entry type for the UI.
 */
function inferActivityType(action: string): "connected" | "disconnected" | "synced" | "refreshed" | "error" | "configured" {
  const lower = action.toLowerCase();
  if (lower.includes("disconnect")) return "disconnected";
  if (lower.includes("connect")) return "connected";
  if (lower.includes("sync") || lower.includes("fetch")) return "synced";
  if (lower.includes("refresh")) return "refreshed";
  if (lower.includes("error") || lower.includes("fail")) return "error";
  return "configured";
}
