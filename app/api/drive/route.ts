import { withHandler } from "@/lib/api/handler";
import { driveService } from "@/lib/services/drive";
import { logger } from "@/lib/logger";
import { validateSchema } from "@/lib/validators";
import { gmailSearchSchema } from "@/lib/validators/gmail";

export const dynamic = "force-dynamic";

export const GET = withHandler(async (request: Request) => {
  logger.debug("GET /api/drive - handler");
  const url = new URL(request.url);
  const payload = { query: url.searchParams.get("q") ?? "", maxResults: undefined };
  const validated = validateSchema(gmailSearchSchema, payload);
  logger.info("Drive search validated", { query: validated.query });

  const res = await driveService.searchDrive(validated.query);
  return { message: "Drive results", data: res };
});
