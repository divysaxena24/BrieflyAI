import { withHandler } from "@/lib/api/handler";
import { calendarService } from "@/lib/services/calendar";
import { logger } from "@/lib/logger";
import { validateSchema } from "@/lib/validators";
import { calendarEventQuery } from "@/lib/validators/calendar";

export const dynamic = "force-dynamic";

export const GET = withHandler(async (request: Request) => {
  logger.debug("GET /api/calendar - handler");
  const url = new URL(request.url);
  const payload = {
    calendarId: url.searchParams.get("calendarId") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  };

  const validated = validateSchema(calendarEventQuery, payload);
  logger.info("Calendar query validated", { calendarId: validated.calendarId });

  const res = await calendarService.listEvents(validated.calendarId);
  return { message: "Events list", data: res };
});
