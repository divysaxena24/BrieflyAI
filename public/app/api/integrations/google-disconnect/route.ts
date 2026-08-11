import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { registry } from "@/lib/services/integrations/registry";
import { logger } from "@/lib/logger";
import { getUserIntegrationByPlatform, findUserByAuthId, logActivity } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  registry.bootstrapProviders();

  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const { data: userData } = await supabase.auth.getUser();
  const authUserId = userData?.user?.id;
  if (!authUserId) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

  // Convert Supabase auth UUID → application user UUID (integrations.user_id references users.id)
  const appUser = await findUserByAuthId(authUserId);
  if (!appUser) return NextResponse.json({ message: "Application user not found" }, { status: 404 });
  const userId = appUser.id;

  const url = new URL(request.url);
  const platform = url.searchParams.get("platform") ?? "gmail";

  const integration = await getUserIntegrationByPlatform(userId, platform);
  if (!integration) return NextResponse.json({ message: "No integration found" }, { status: 404 });

  // Delegate to provider disconnect
  const provider = registry.getProvider("google");
  await provider.disconnect({ integrationId: integration.id, userId });

  // Log the disconnection activity
  try {
    await logActivity({
      userId,
      platform,
      action: `Disconnected ${platform.charAt(0).toUpperCase() + platform.slice(1)}`,
      details: `Integration disconnected by user`,
      integrationId: integration.id,
      metadata: {},
    });
  } catch (logErr) {
    logger.debug("Failed to log activity", { error: String(logErr) });
  }

  logger.info("Google disconnected", { userId, integrationId: integration.id, platform });

  return NextResponse.json({ message: "Disconnected" });
}
