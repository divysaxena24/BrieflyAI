import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { registry } from "@/lib/services/integrations/registry";
import { withHandler } from "@/lib/api/handler";
import { findUserByAuthId } from "@/lib/db/queries";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * POST /api/integrations/whatsapp-connect
 * WhatsApp uses QR-code session pairing (Baileys) — there is NO OAuth redirect,
 * callback, auth URL, or token body. This route starts the session and returns
 * its state immediately; the client then polls /api/integrations/whatsapp-qr
 * and /api/integrations/whatsapp-status until the QR code is scanned.
 *
 * There is nothing to validate here — WhatsApp connect takes no request body
 * (unlike Telegram's bot-token connect).
 */
export const POST = withHandler(async () => {
  registry.bootstrapProviders();

  // Authenticate the current user (same pattern as GitHub/Discord/Telegram routes)
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);
  const { data: userData } = await supabase.auth.getUser();
  const authUserId = userData?.user?.id;
  if (!authUserId) throw new AppError("Unauthorized", 401, "authentication_required");

  // Resolve auth.users.id → users.id (integrations.user_id references users.id)
  const appUser = await findUserByAuthId(authUserId);
  if (!appUser) throw new AppError("Application user not found", 404, "user_not_found");

  // Delegate to the WhatsApp provider — it creates the integration row and
  // starts the Baileys session via the session manager, but does NOT mark the
  // integration connected (that happens only after the QR scan).
  const provider = registry.getProvider("whatsapp");
  const res = await provider.connect({
    userId: appUser.id,
    platform: "whatsapp",
  });

  return { message: res.message ?? "WhatsApp session started", data: res.payload ?? null };
});
