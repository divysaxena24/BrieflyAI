import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export async function listEvents(_calendarId?: string) {
  logger.debug("Calendar: listEvents called (placeholder)");
  throw new AppError("Calendar service not implemented", 501, "not_implemented");
}

export const calendarService = { listEvents };

export default calendarService;
