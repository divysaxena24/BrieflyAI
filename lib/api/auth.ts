/**
 * Engine API authentication (Phase 5J STEP 4).
 *
 * The repository has no auth middleware; the established convention is an
 * inline supabase session check inside each route (see `app/api/activity`).
 * This module centralizes that check into a single helper the engine routes
 * reuse — no new infrastructure, no duplicated auth code.
 */

import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { findUserByAuthId } from "@/lib/db/queries";
import { AuthenticationError, AuthorizationError } from "@/lib/errors";

/**
 * Resolve the authenticated application user id.
 *
 * Throws `AuthenticationError` (401) without a session and
 * `AuthorizationError` (403) when the authenticated account has no app
 * profile. The returned id doubles as the persistence scope.
 */
export async function requireAppUserId(): Promise<string> {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);
  const { data: userData } = await supabase.auth.getUser();
  const authUserId = userData?.user?.id;
  if (authUserId === undefined || authUserId === null) {
    throw new AuthenticationError();
  }
  const appUser = await findUserByAuthId(authUserId);
  if (appUser === null || appUser === undefined) {
    throw new AuthorizationError("Authenticated user has no app profile");
  }
  return appUser.id;
}
