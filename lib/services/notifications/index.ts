import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export async function createNotification(_payload: any) {
  logger.debug("Notifications: createNotification called (placeholder)");
  throw new AppError("Notifications service not implemented", 501, "not_implemented");
}

export const notificationsService = { createNotification };

export default notificationsService;
