import { NextResponse } from "next/server";
import CalendarService from "@/lib/services/calendar";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";
import { calendarEventQuery, calendarPaginationSchema } from "@/lib/validators/calendar";

export const dynamic = "force-dynamic";

export default async function handler(request: Request) {
  logger.info("API: GET /api/calendar-events received");
  const url = new URL(request.url);
  const calendarId = url.searchParams.get("calendarId") ?? undefined;
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  const maxResults = url.searchParams.get("maxResults") ?? undefined;
  const pageToken = url.searchParams.get("pageToken") ?? undefined;

  try {
    calendarEventQuery.parse({ calendarId, from, to });
    const parsedPage = calendarPaginationSchema.parse({ maxResults: maxResults ? Number(maxResults) : undefined, pageToken: pageToken ?? undefined });
    const result = await CalendarService.listEvents({ calendarId, from, to, maxResults: parsedPage.maxResults, pageToken: parsedPage.pageToken });
    return NextResponse.json(result);
  } catch (err: any) {
    logger.error("API: /api/calendar-events error", { error: String(err) });
    if (err instanceof AppError) return NextResponse.json({ message: err.message, code: err.code }, { status: err.status });
    if (err?.name === "ZodError") return NextResponse.json({ message: "Invalid parameters" }, { status: 400 });
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }
}
