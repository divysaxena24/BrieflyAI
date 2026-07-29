import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export async function searchDrive(_query: string) {
  logger.debug("Drive: searchDrive called (placeholder)");
  throw new AppError("Drive service not implemented", 501, "not_implemented");
}

export const driveService = { searchDrive };

export default driveService;
