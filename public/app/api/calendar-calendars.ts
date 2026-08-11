import { NextResponse } from "next/server";
import CalendarService from "@/lib/services/calendar";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export default async function handler() {
  logger.info("API: GET /api/calendar-calendars received");
  try {
    const calendars = await CalendarService.listCalendars();
    return NextResponse.json({ calendars });
  } catch (err: any) {
    logger.error("API: /api/calendar-calendars error", { error: String(err) });
    if (err instanceof AppError) return NextResponse.json({ message: err.message, code: err.code }, { status: err.status });
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }
}
