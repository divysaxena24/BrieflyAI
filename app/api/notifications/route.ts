import { withHandler } from "@/lib/api/handler";
import { notificationsService } from "@/lib/services/notifications";
import { logger } from "@/lib/logger";
import { validateSchema } from "@/lib/validators";
import { createNotificationSchema } from "@/lib/validators/notifications";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export const POST = withHandler(async (request: Request) => {
  logger.debug("POST /api/notifications - handler");
  let body: any;
  try {
    body = await request.json();
  } catch (err) {
    logger.warn("Invalid JSON in request body", { error: (err as Error)?.message });
    throw new AppError("Request body is missing or contains invalid JSON.", 400, "invalid_json");
  }

  // Treat explicit empty object/null as invalid JSON/body missing
  if (body == null || (typeof body === "object" && Object.keys(body).length === 0)) {
    logger.warn("Empty request body", { body });
    throw new AppError("Request body is missing or contains invalid JSON.", 400, "invalid_json");
  }

  const validated = validateSchema(createNotificationSchema, body);
  logger.info("Notification payload validated", { title: validated.title, userId: validated.userId });

  const res = await notificationsService.createNotification(validated);
  return { message: "Notification created", data: res };
});
