import { withHandler } from "@/lib/api/handler";
import { githubService } from "@/lib/services/github";
import { logger } from "@/lib/logger";
import { validateSchema } from "@/lib/validators";
import { githubReposSearchSchema } from "@/lib/validators/github";

export const dynamic = "force-dynamic";

export const GET = withHandler(async (request: Request) => {
  logger.debug("GET /api/github/repos/search - handler");
  const url = new URL(request.url);

  const payload = {
    query: url.searchParams.get("query") ?? url.searchParams.get("q") ?? "",
    sort: url.searchParams.get("sort") ?? undefined,
    order: url.searchParams.get("order") ?? undefined,
    page: url.searchParams.get("page") ? Number(url.searchParams.get("page")) : undefined,
    perPage: url.searchParams.get("perPage") ? Number(url.searchParams.get("perPage")) : undefined,
  };

  const validated = validateSchema(githubReposSearchSchema, payload);
  logger.info("GitHub repos search validated", { query: validated.query, sort: validated.sort, order: validated.order });

  const res = await githubService.searchRepositories(validated);
  return { message: "Repository search results", data: res };
});
