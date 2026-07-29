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
  logger.info("GitHub query validated", { owner: validated.owner, repo: validated.repo });

  const res = await githubService.listRepos(validated.owner ?? "");
  return { message: "Repository list", data: res };
});
