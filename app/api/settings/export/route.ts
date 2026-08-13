import { NextResponse } from "next/server";
import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { exportSettingsData } from "@/lib/settings/service";

export const dynamic = "force-dynamic";

/** Download all of the user's settings and chat data as a JSON file. */
export const GET = withHandler(async () => {
  const userId = await requireAppUserId();
  const payload = await exportSettingsData(userId);
  const json = JSON.stringify(payload, null, 2);
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(json, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="brieflyai-export-${date}.json"`,
    },
  });
});
