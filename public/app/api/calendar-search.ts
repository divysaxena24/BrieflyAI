import { NextResponse } from "next/server";
import CalendarService from "@/lib/services/calendar";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";
import { calendarSearchSchema } from "@/lib/validators/calendar";

export const dynamic = "force-dynamic";

export default async function handler(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const calendarId = url.searchParams.get("calendarId") ?? undefined;
  const maxResults = url.searchParams.get("maxResults") ?? undefined;
  const pageToken = url.searchParams.get("pageToken") ?? undefined;

  logger.info("API: GET /api/calendar-search received", { q });
  try {
    const parsed = calendarSearchSchema.parse({ query: q, calendarId, maxResults: maxResults ? Number(maxResults) : undefined });
    const result = await CalendarService.searchEvents(parsed.query, parsed.calendarId, parsed.maxResults ?? 20, pageToken ?? undefined);
    return NextResponse.json(result);
  } catch (err: any) {
    logger.error("API: /api/calendar-search error", { error: String(err) });
    if (err instanceof AppError) return NextResponse.json({ message: err.message, code: err.code }, { status: err.status });
    if (err?.name === "ZodError") return NextResponse.json({ message: "Invalid query" }, { status: 400 });
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }
}
