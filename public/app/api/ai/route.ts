import { withHandler } from "@/lib/api/handler";
import { aiService } from "@/lib/services/ai";
import { logger } from "@/lib/logger";
import { validateSchema } from "@/lib/validators";
import { chatMessageSchema } from "@/lib/validators/ai";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export const POST = withHandler(async (request: Request) => {
  logger.debug("POST /api/ai - handler");
  let body: any;
  try {
    body = await request.json();
  } catch (err) {
    logger.warn("Invalid JSON in request body", { error: (err as Error)?.message });
    throw new AppError("Request body is missing or contains invalid JSON.", 400, "invalid_json");
  }

  if (body == null || (typeof body === "object" && Object.keys(body).length === 0)) {
    logger.warn("Empty request body", { body });
    throw new AppError("Request body is missing or contains invalid JSON.", 400, "invalid_json");
  }
  const validated = validateSchema(chatMessageSchema, body);
  logger.info("AI request validated", { len: String((validated.message || "").length) });

  const res = await aiService.generateSummary(validated.message);
  return { message: "Summary generated", data: res };
});