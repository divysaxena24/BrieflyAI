import { withHandler } from "@/lib/api/handler";
import { logger } from "@/lib/logger";
import { gmailService } from "@/lib/services/gmail";
import { validateSchema } from "@/lib/validators";
import { gmailSearchSchema, gmailPaginationSchema } from "@/lib/validators/gmail";

export const dynamic = "force-dynamic";

export const GET = withHandler(async (request: Request) => {
  logger.debug("GET /api/gmail - handler");
  const url = new URL(request.url);
  const payload = {
    query: url.searchParams.get("q") ?? "",
    maxResults: url.searchParams.get("maxResults") ? Number(url.searchParams.get("maxResults")) : undefined,
  };

  const validated = validateSchema(gmailSearchSchema, payload);
  const pagination = validateSchema(gmailPaginationSchema, { maxResults: validated.maxResults, pageToken: url.searchParams.get("pageToken") ?? undefined });
  logger.info("Gmail search validated", { query: validated.query, maxResults: validated.maxResults });

  const res = await gmailService.searchMessages(validated.query, pagination.maxResults, pagination.pageToken);
  return { message: "Search results", data: res };
});
