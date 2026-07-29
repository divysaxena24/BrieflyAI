import { withHandler } from "@/lib/api/handler";
import { integrationsService } from "@/lib/services/integrations";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export const GET = withHandler(async (_req: Request) => {
  logger.debug("GET /api/integrations - handler");
  const list = integrationsService.listIntegrations();
  logger.info("Integrations listed", { count: list.length });
  return { message: "Integrations list", data: list };
});
