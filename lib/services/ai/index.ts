import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export async function generateSummary(_text: string) {
  logger.debug("AI: generateSummary called (placeholder)");
  throw new AppError("AI service not implemented", 501, "not_implemented");
}

export const aiService = { generateSummary };

export default aiService;
