import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { registry } from "@/lib/services/integrations/registry";
import { withHandler } from "@/lib/api/handler";
import { validateSchema } from "@/lib/validators";
import { telegramConnectSchema } from "@/lib/validators/telegram";
import { findUserByAuthId } from "@/lib/db/queries";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * POST /api/integrations/telegram-connect
 * Telegram uses Bot Token authentication — there is NO OAuth redirect, callback,
 * auth URL, state cookie, or CSRF. The client sends the bot token in the body:
 *   { "token": "<telegram bot token>" }
 */
export const POST = withHandler(async (request: Request) => {
  registry.bootstrapProviders();

  // Authenticate the current user (same pattern as GitHub/Discord routes)
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);
  const { data: userData } = await supabase.auth.getUser();
  const authUserId = userData?.user?.id;
  if (!authUserId) throw new AppError("Unauthorized", 401, "authentication_required");

  // Resolve auth.users.id → users.id (integrations.user_id references users.id)
  const appUser = await findUserByAuthId(authUserId);
  if (!appUser) throw new AppError("Application user not found", 404, "user_not_found");
  const userId = appUser.id;

  // Parse + validate the request body
  const body = await request.json().catch(() => ({}));
  const validated = validateSchema(telegramConnectSchema, body);

  // Delegate to the Telegram provider — it validates the token via getMe(),
  // creates the integration, stores the token, and logs "Connected Telegram"
  // activity (no duplicate logging in the route).
  const provider = registry.getProvider("telegram");
  // The provider logs its own connect activity — no duplicate logging here.
  const res = await provider.connect({
    userId,
    platform: "telegram",
    config: { token: validated.token },
  });

  return { message: "Connected Telegram", data: res.payload ?? null };
});
