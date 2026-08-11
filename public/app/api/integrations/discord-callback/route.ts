import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { registry } from "@/lib/services/integrations/registry";
import { logger } from "@/lib/logger";
import { db, integrations, oauthTokens } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getUserIntegrationByPlatform, createIntegration, updateIntegrationStatus, findUserByAuthId, logActivity } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

/**
 * Fetch the authenticated Discord user profile.
 * Returns null if the request fails (best-effort, like fetchGitHubUserInfo).
 * GET https://discord.com/api/users/@me — shape:
 * { id, username, global_name, avatar, email?, ... }
 */
async function fetchDiscordUserInfo(accessToken: string) {
  try {
    const res = await fetch("https://discord.com/api/users/@me", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn("Discord UserInfo fetch failed", { status: res.status, body });
      return null;
    }

    const data = (await res.json()) as {
      id?: string;
      username?: string;
      global_name?: string | null;
      avatar?: string | null;
      email?: string | null;
    };

    // Avatar CDN URL: https://cdn.discordapp.com/avatars/{user_id}/{hash}.png
    // (use .gif when the hash starts with "a_", which denotes an animated avatar)
    let avatarUrl: string | null = null;
    if (data.id && data.avatar) {
      const ext = data.avatar.startsWith("a_") ? "gif" : "png";
      avatarUrl = `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.${ext}`;
    }

    logger.info("Discord UserInfo fetched", { id: data?.id, username: data?.username });
    return { ...data, avatarUrl };
  } catch (err) {
    logger.warn("Discord UserInfo fetch threw", { error: String(err) });
    return null;
  }
}

export async function GET(request: Request) {
  // Bootstrap providers
  registry.bootstrapProviders();

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const next = url.searchParams.get("next") ?? "/dashboard/integrations/discord";

  // Retrieve and validate state cookie
  const cookieStore = await cookies();
  const raw = cookieStore.get("briefly_oauth_state")?.value;
  if (!raw) {
    logger.warn("Discord callback: missing state cookie");
    return NextResponse.json({ message: "Invalid state" }, { status: 400 });
  }

  let parsed: { state?: string; platform?: string; next?: string } | null = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn("Discord callback: malformed state cookie", { err });
    return NextResponse.json({ message: "Invalid state" }, { status: 400 });
  }

  if (!parsed) {
    logger.warn("Discord callback: empty state cookie");
    return NextResponse.json({ message: "Invalid state" }, { status: 400 });
  }

  if (!state || parsed.state !== state) {
    logger.warn("Discord callback: state mismatch", { state, cookieState: parsed.state });
    return NextResponse.json({ message: "Invalid state" }, { status: 400 });
  }

  if (!code) {
    logger.warn("Discord callback: missing code");
    return NextResponse.json({ message: "Missing authorization code" }, { status: 400 });
  }

  const platform = parsed.platform ?? "discord";

  // Resolve the application user from the authenticated session
  const supabase = createClient(cookieStore);
  const { data: userData } = await supabase.auth.getUser();
  const authUserId = userData?.user?.id;
  if (!authUserId) {
    logger.warn("Discord callback: not authenticated");
    return NextResponse.json({ message: "Not authenticated" }, { status: 401 });
  }

  const appUser = await findUserByAuthId(authUserId);
  if (!appUser) {
    logger.error("Discord callback: application user not found", { authUserId });
    return NextResponse.json({ message: "Application user not found" }, { status: 404 });
  }

  const userId = appUser.id;

  // Exchange code for tokens (Discord returns JSON with access_token,
  // refresh_token, expires_in, scope)
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: process.env.DISCORD_CLIENT_ID ?? "",
      client_secret: process.env.DISCORD_CLIENT_SECRET ?? "",
      // RAW value — must exactly match the redirect_uri used during authorization.
      redirect_uri: process.env.DISCORD_REDIRECT_URI ?? "",
      grant_type: "authorization_code",
    }),
  });

  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenRes.ok || !tokenJson.access_token) {
    // Discord error body: { error, error_description }
    const dcError = tokenJson.error_description ?? tokenJson.error ?? "unknown";
    logger.error("Discord token exchange failed", { status: tokenRes.status, error: dcError });
    return NextResponse.json({ message: "Token exchange failed", error: dcError }, { status: 500 });
  }

  const { access_token, refresh_token, expires_in, scope } = tokenJson;

  // Upsert integration record for the platform (avoids duplicate rows)
  let integration = await getUserIntegrationByPlatform(userId, platform);
  if (!integration) {
    integration = await createIntegration({ userId, platform, permissions: "read", metadata: JSON.stringify({ provider: "discord" }) });
  }

  // Fetch Discord account info and store name/email/avatar
  const userInfo = await fetchDiscordUserInfo(access_token);
  if (userInfo) {
    const accountName = userInfo.global_name ?? userInfo.username ?? null;
    const accountEmail = userInfo.email ?? null;
    await db
      .update(integrations)
      .set({
        accountEmail,
        accountName,
        metadata: JSON.stringify({
          provider: "discord",
          accountEmail,
          accountName,
          avatarUrl: userInfo.avatarUrl ?? null,
        }),
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, integration.id));
    logger.info("Discord account info stored", { email: accountEmail, platform, integrationId: integration.id });
  }

  // Upsert oauth_tokens (Discord tokens are expiring ~7 days and refreshable)
  const expiresAt = expires_in ? new Date(Date.now() + Number(expires_in) * 1000) : null;
  const existing = await db.select().from(oauthTokens).where(eq(oauthTokens.integrationId, integration.id)).limit(1);
  if (existing.length > 0) {
    await db
      .update(oauthTokens)
      .set({ accessToken: access_token, refreshToken: refresh_token, scope, expiresAt, updatedAt: new Date() })
      .where(eq(oauthTokens.integrationId, integration.id))
      .returning();
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

  // Log the connection activity
  try {
    await logActivity({
      userId,
      platform,
      action: `Connected ${platform.charAt(0).toUpperCase() + platform.slice(1)}`,
      details: `Successfully connected via Discord OAuth`,
      integrationId: integration.id,
      metadata: { scopes: scope },
    });
  } catch (logErr) {
    logger.debug("Failed to log activity", { error: String(logErr) });
  }

  logger.info("Discord OAuth connected", { userId, platform, integrationId: integration.id });

  const redirectUrl = new URL(next, request.url);
  return NextResponse.redirect(redirectUrl);
}
