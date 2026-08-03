import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { withHandler } from "@/lib/api/handler";
import { whatsappSessionManager } from "@/lib/services/whatsapp/whatsappSessionManager";
import { getUserIntegrationByPlatform, findUserByAuthId } from "@/lib/db/queries";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * GET /api/integrations/whatsapp-qr
 * Returns the current QR code string for the user's WhatsApp session.
 *
 * The QR is served raw (not converted to PNG) — the client renders it with a
 * QR library. The UI polls this endpoint while the connect dialog is open.
 * When no QR exists yet (session still starting, or already scanned/closed),
 * the response is { qr: null }.
 */
export const GET = withHandler(async () => {
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

  // Ask the session manager for the current QR. A missing in-memory session
  // (e.g. after a server restart) surfaces as { qr: null }, not an error.
  let qr: string | null = null;
  try {
    qr = whatsappSessionManager.getCurrentQr(integration.id);
  } catch (err) {
    // Session not started in this process — treat as "no QR yet"
    if (err instanceof AppError && err.code === "whatsapp_session_not_found") {
      qr = null;
    } else {
      throw err;
    }
  }

  return { message: "WhatsApp QR code", data: { qr } };
});
