import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { registry } from "@/lib/services/integrations/registry";
import { logger } from "@/lib/logger";
import { getUserIntegrationByPlatform } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export default async function handler(request: Request) {
  registry.bootstrapProviders();

  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const platform = url.searchParams.get("platform") ?? "gmail";

  const integration = await getUserIntegrationByPlatform(userId, platform);
  if (!integration) return NextResponse.json({ message: "No integration found" }, { status: 404 });

  // Delegate to provider disconnect
  const provider = registry.getProvider("google");
  await provider.disconnect({ integrationId: integration.id, userId });

  logger.info("Google disconnected", { userId, integrationId: integration.id, platform });

  return NextResponse.json({ message: "Disconnected" });
}