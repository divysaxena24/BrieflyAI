import { logger } from "@/lib/logger";
import { handleAIRequest, type AIOrchestratorResult } from "@/lib/ai";

/**
 * AI service — the seam the `/api/ai` route calls.
 *
 * Routes a natural-language message through the AI orchestrator: tool
 * selection → real integration data → Groq natural-language response.
 */
export async function generateSummary(message: string): Promise<AIOrchestratorResult> {
  logger.debug("AI: generateSummary called");
  return handleAIRequest({ query: message });
}

export const aiService = { generateSummary };

export default aiService;
