import { withHandler } from "@/lib/api/handler";
import { githubService } from "@/lib/services/github";
import { logger } from "@/lib/logger";
import { validateSchema } from "@/lib/validators";
import { githubRepoQuerySchema } from "@/lib/validators/github";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ owner: string; repo: string }>;
}

export const GET = withHandler(async (_request: Request, context: unknown) => {
  logger.debug("GET /api/github/repos/:owner/:repo - handler");
  // Next.js 16 passes dynamic route params as a Promise in the second argument
  const { owner, repo } = await (context as RouteContext).params;

  const validated = validateSchema(githubRepoQuerySchema, { owner, repo });
  logger.info("GitHub repo query validated", { owner: validated.owner, repo: validated.repo });

  const res = await githubService.getRepository(validated.owner, validated.repo);
  return { message: "Repository detail", data: res };
});
