import { withHandler } from "@/lib/api/handler";
import { githubService } from "@/lib/services/github";
import { logger } from "@/lib/logger";
import { validateSchema } from "@/lib/validators";
import { githubQuerySchema } from "@/lib/validators/github";

export const dynamic = "force-dynamic";

export const GET = withHandler(async (request: Request) => {
  logger.debug("GET /api/github - handler");
  const url = new URL(request.url);
  const payload = {
    owner: url.searchParams.get("owner") ?? undefined,
    repo: url.searchParams.get("repo") ?? undefined,
  };

  const validated = validateSchema(githubQuerySchema, payload);

  // Specific repository lookup when both owner + repo are provided
  if (validated.owner && validated.repo) {
    logger.info("GitHub query validated (repo detail)", { owner: validated.owner, repo: validated.repo });
    const res = await githubService.getRepository(validated.owner, validated.repo);
    return { message: "Repository detail", data: res };
  }

  // Otherwise list the authenticated user's repositories.
  // Note: an owner-only query (owner without repo) intentionally lists the
  // authenticated user's repos — this integration is scoped to the user's
  // own GitHub account, so the owner param is ignored in that case.
  const res = await githubService.listRepositories();
  return { message: "Repository list", data: res };
});
