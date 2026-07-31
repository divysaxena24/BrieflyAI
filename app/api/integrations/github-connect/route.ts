import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { registry } from "@/lib/services/integrations/registry";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Bootstrap providers explicitly
  registry.bootstrapProviders();

  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  // Ensure user is signed in
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const platform = url.searchParams.get("platform") ?? "github";
  const next = url.searchParams.get("next") ?? "/dashboard";

  const provider = registry.getProvider("github");
  const res = await provider.connect({ userId, platform });
  const payload = res.payload ?? {};
  const authUrl = payload.authUrl as string | undefined;
  const state = payload.state as string | undefined;

  if (!authUrl || !state) {
    logger.error("GitHub connect: missing authUrl or state");
    return NextResponse.json({ message: "Could not initiate OAuth" }, { status: 500 });
  }

  try {
    const cookieVal = JSON.stringify({ state, platform, next });
    cookieStore.set("briefly_oauth_state", cookieVal, { httpOnly: true, path: "/", sameSite: "lax" });
  } catch (err) {
    logger.debug("Could not set oauth_state cookie", { error: err });
  }

  return NextResponse.redirect(authUrl);
}
