import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { registry } from "@/lib/services/integrations/registry";
import { withHandler } from "@/lib/api/handler";
import { getUserIntegrationByPlatform, findUserByAuthId } from "@/lib/db/queries";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * GET /api/integrations/whatsapp-disconnect
 * Disconnects the WhatsApp integration. Mirrors the Telegram disconnect flow:
 * authenticate → resolve integration → delegate to the provider.
 *
 * The WhatsApp provider handles all the teardown internally (removes the
 * Baileys session, marks the integration not-connected, and logs the
 * "Disconnected WhatsApp" activity) — there is no token manager to invalidate
 * and no duplicate activity logging here.
 */
export const GET = withHandler(async () => {
  registry.bootstrapProviders();

  // Authenticate the current user (same pattern as the other integration routes)
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);
  const { data: userData } = await supabase.auth.getUser();
  const authUserId = userData?.user?.id;
  if (!authUserId) throw new AppError("Unauthorized", 401, "authentication_required");

  // Resolve auth.users.id → users.id (integrations.user_id references users.id)
  const appUser = await findUserByAuthId(authUserId);
  if (!appUser) throw new AppError("Application user not found", 404, "user_not_found");

  // Resolve the WhatsApp integration for this user
  const integration = await getUserIntegrationByPlatform(appUser.id, "whatsapp");
  if (!integration) throw new AppError("No WhatsApp integration found", 404, "integration_not_found");

  // Delegate to the provider disconnect (removes session + marks not-connected)
  const provider = registry.getProvider("whatsapp");
  const res = await provider.disconnect({ integrationId: integration.id, userId: appUser.id });

  return { message: res.message ?? "Disconnected WhatsApp", data: null };
});
