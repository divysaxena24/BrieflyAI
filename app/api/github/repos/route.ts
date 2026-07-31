import { withHandler } from "@/lib/api/handler";
import { githubService } from "@/lib/services/github";
import { logger } from "@/lib/logger";
import { validateSchema } from "@/lib/validators";
import { githubReposListSchema } from "@/lib/validators/github";

export const dynamic = "force-dynamic";

export const GET = withHandler(async (request: Request) => {
  logger.debug("GET /api/github/repos - handler");
  const url = new URL(request.url);

  const payload = {
    page: url.searchParams.get("page") ? Number(url.searchParams.get("page")) : undefined,
    perPage: url.searchParams.get("perPage") ? Number(url.searchParams.get("perPage")) : undefined,
    sort: url.searchParams.get("sort") ?? undefined,
    direction: url.searchParams.get("direction") ?? undefined,
    visibility: url.searchParams.get("visibility") ?? undefined,
    affiliation: url.searchParams.get("affiliation") ?? undefined,
  };

  const validated = validateSchema(githubReposListSchema, payload);
  logger.info("GitHub repos list validated", { sort: validated.sort, page: validated.page, perPage: validated.perPage });

  const res = await githubService.listRepositories(validated);
  return { message: "Repository list", data: res };
});
