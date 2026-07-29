import { withHandler } from "@/lib/api/handler";
import { driveService } from "@/lib/services/drive";
import { logger } from "@/lib/logger";
import { validateSchema } from "@/lib/validators";
import { driveSearchSchema } from "@/lib/validators/drive";

export const dynamic = "force-dynamic";

export const GET = withHandler(async (request: Request) => {
  logger.debug("GET /api/drive - handler");
  const url = new URL(request.url);
  const payload = { query: url.searchParams.get("q") ?? "", pageSize: url.searchParams.get("pageSize") ? Number(url.searchParams.get("pageSize")) : undefined, pageToken: url.searchParams.get("pageToken") ?? undefined };
  const validated = validateSchema(driveSearchSchema, payload);
  logger.info("Drive search validated", { query: validated.query });

  const res = await driveService.searchFiles(validated.query, validated.pageSize);
  return { message: "Drive results", data: res };
});
