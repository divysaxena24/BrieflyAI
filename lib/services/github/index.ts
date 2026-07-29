import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export async function listRepos(_owner: string) {
  logger.debug("GitHub: listRepos called (placeholder)");
  throw new AppError("GitHub service not implemented", 501, "not_implemented");
}

export const githubService = { listRepos };

export default githubService;
