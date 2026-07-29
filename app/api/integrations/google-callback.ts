import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { registry } from "@/lib/services/integrations/registry";
import { logger } from "@/lib/logger";
import { db, oauthTokens } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getUserIntegrationByPlatform, createIntegration, updateIntegrationStatus } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export default async function handler(request: Request) {
  // Bootstrap providers
  registry.bootstrapProviders();

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const next = url.searchParams.get("next") ?? "/dashboard";

  // Retrieve and validate state cookie
  const cookieStore = await cookies();
  const raw = cookieStore.get("briefly_oauth_state")?.value;
  if (!raw) {
    logger.warn("Google callback: missing state cookie");
    return NextResponse.json({ message: "Invalid state" }, { status: 400 });
  }

  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn("Google callback: malformed state cookie", { err });
    return NextResponse.json({ message: "Invalid state" }, { status: 400 });
  }

  if (!state || parsed.state !== state) {
    logger.warn("Google callback: state mismatch", { state, cookieState: parsed.state });
    return NextResponse.json({ message: "Invalid state" }, { status: 400 });
  }

  if (!code) {
    logger.warn("Google callback: missing code");
    return NextResponse.json({ message: "Missing authorization code" }, { status: 400 });
  }

  const platform = parsed.platform ?? "google";
  const userId = parsed.userId;

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: process.env.GOOGLE_REDIRECT_URI ?? "",
      grant_type: "authorization_code",
    }),
  });

  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok) {
    logger.error("Google token exchange failed", { tokenJson });
    return NextResponse.json({ message: "Token exchange failed" }, { status: 500 });
  }

  const { access_token, refresh_token, expires_in, scope, id_token } = tokenJson as any;

  // Upsert integration record for the provided platform (keep platform like 'gmail' so UI remains compatible)
  let integration = await getUserIntegrationByPlatform(userId, platform);
  if (!integration) {
    integration = await createIntegration({ userId, platform, permissions: "read", metadata: JSON.stringify({ provider: "google" }) });
  }

  // Upsert oauth_tokens
  const expiresAt = expires_in ? new Date(Date.now() + Number(expires_in) * 1000) : null;
  const existing = await db.select().from(oauthTokens).where(eq(oauthTokens.integrationId, integration.id)).limit(1);
  if (existing.length > 0) {
    await db.update(oauthTokens).set({ accessToken: access_token, refreshToken: refresh_token, scope, expiresAt, updatedAt: new Date() }).where(eq(oauthTokens.integrationId, integration.id)).returning();
  } else {
    await db.insert(oauthTokens).values({ integrationId: integration.id, accessToken: access_token, refreshToken: refresh_token, scope, expiresAt }).returning();
  }

  // Update integration status to connected
  await updateIntegrationStatus(integration.id, "connected");

  // Clear state cookie
  try {
    cookieStore.delete("briefly_oauth_state");
  } catch (err) {
    logger.debug("Could not clear oauth_state cookie", { err });
  }

  logger.info("Google OAuth connected", { userId, platform, integrationId: integration.id });

  return NextResponse.redirect(next);
}
