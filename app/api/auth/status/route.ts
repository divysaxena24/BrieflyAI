import { withHandler } from "@/lib/api/handler";
import { authService } from "@/lib/services/auth";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export const GET = withHandler(async (_req: Request) => {
  logger.debug("GET /api/auth/status - handler");
  const user = await authService.getCurrentUser();
  logger.info("Auth status retrieved", { user: user ? { id: user.id, email: user.email } : null });
  return { message: "User status retrieved", data: user ?? null };
});
