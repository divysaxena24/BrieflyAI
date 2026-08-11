import { getCurrentUser as getSupabaseCurrentUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Auth service: thin wrapper around existing Supabase helpers.
 * Responsibilities:
 * - Provide a single place to interact with authentication from server code
 * - Keep route handlers free of auth logic
 */

export async function getCurrentUser() {
  try {
    const user = await getSupabaseCurrentUser();
    return user;
  } catch (err) {
    logger.error("Auth:getCurrentUser error", err);
    throw new AppError("Failed to retrieve current user", 500);
  }
}

export const authService = {
  getCurrentUser,
};

export default authService;
