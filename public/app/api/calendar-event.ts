import { NextResponse } from "next/server";
import CalendarService from "@/lib/services/calendar";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";
import { calendarEventIdSchema } from "@/lib/validators/calendar";

export const dynamic = "force-dynamic";

export default async function handler(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const calendarId = url.searchParams.get("calendarId") ?? undefined;
  logger.info("API: GET /api/calendar-event received", { eventId: id, calendarId });
  try {
    const parsed = calendarEventIdSchema.parse(id);
    const event = await CalendarService.getEvent(parsed, calendarId ?? undefined);
    return NextResponse.json(event);
  } catch (err: any) {
    logger.error("API: /api/calendar-event error", { error: String(err) });
    if (err instanceof AppError) return NextResponse.json({ message: err.message, code: err.code }, { status: err.status });
    if (err?.name === "ZodError") return NextResponse.json({ message: "Invalid event id" }, { status: 400 });
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }
}
