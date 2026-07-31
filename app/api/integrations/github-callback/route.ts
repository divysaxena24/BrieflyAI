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
 * Fetch the authenticated GitHub user profile.
 * Returns null if the request fails (best-effort, like fetchGoogleUserInfo).
 */
async function fetchGitHubUserInfo(accessToken: string) {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn("GitHub UserInfo fetch failed", { status: res.status, body });
      return null;
    }

    const data = (await res.json()) as {
      login?: string;
      name?: string | null;
      email?: string | null;
      avatar_url?: string | null;
    };

    // GET /user only returns `email` when it is public. With the `user:email`
    // scope we can fall back to /user/emails for the primary verified address.
    let email = data.email ?? null;
    if (!email) {
      try {
        const emailsRes = await fetch("https://api.github.com/user/emails", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
        if (emailsRes.ok) {
          const emails = (await emailsRes.json()) as Array<{
            email?: string;
            primary?: boolean;
            verified?: boolean;
          }>;
          email =
            emails.find((e) => e.primary && e.verified)?.email ??
            emails[0]?.email ??
            null;
        }
      } catch (err) {
        logger.debug("GitHub email fetch failed", { error: String(err) });
      }
    }

    logger.info("GitHub UserInfo fetched", { login: data?.login, name: data?.name });
    return { ...data, email };
  } catch (err) {
    logger.warn("GitHub UserInfo fetch threw", { error: String(err) });
    return null;
  }
}

export async function GET(request: Request) {
  // Bootstrap providers
  registry.bootstrapProviders();

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const next = url.searchParams.get("next") ?? "/dashboard/integrations/github";

  // Retrieve and validate state cookie
  const cookieStore = await cookies();
  const raw = cookieStore.get("briefly_oauth_state")?.value;
  if (!raw) {
    logger.warn("GitHub callback: missing state cookie");
    return NextResponse.json({ message: "Invalid state" }, { status: 400 });
  }

  let parsed: { state?: string; platform?: string; next?: string } | null = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn("GitHub callback: malformed state cookie", { err });
    return NextResponse.json({ message: "Invalid state" }, { status: 400 });
  }

  if (!parsed) {
    logger.warn("GitHub callback: empty state cookie");
    return NextResponse.json({ message: "Invalid state" }, { status: 400 });
  }

  if (!state || parsed.state !== state) {
    logger.warn("GitHub callback: state mismatch", { state, cookieState: parsed.state });
    return NextResponse.json({ message: "Invalid state" }, { status: 400 });
  }

  if (!code) {
    logger.warn("GitHub callback: missing code");
    return NextResponse.json({ message: "Missing authorization code" }, { status: 400 });
  }

  const platform = parsed.platform ?? "github";

  // Resolve the application user from the authenticated session
  const supabase = createClient(cookieStore);
  const { data: userData } = await supabase.auth.getUser();
  const authUserId = userData?.user?.id;
  if (!authUserId) {
    logger.warn("GitHub callback: not authenticated");
    return NextResponse.json({ message: "Not authenticated" }, { status: 401 });
  }

  const appUser = await findUserByAuthId(authUserId);
  if (!appUser) {
    logger.error("GitHub callback: application user not found", { authUserId });
    return NextResponse.json({ message: "Application user not found" }, { status: 404 });
  }

  const userId = appUser.id;

  // Exchange code for an access token (GitHub returns JSON only when Accept: application/json)
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      code,
      client_id: process.env.GITHUB_CLIENT_ID ?? "",
      client_secret: process.env.GITHUB_CLIENT_SECRET ?? "",
      redirect_uri: process.env.GITHUB_REDIRECT_URI ?? "",
    }),
  });

  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenRes.ok || !tokenJson.access_token) {
    // GitHub returns HTTP 200 with { error: "bad_verification_code" } on failure
    const ghError = tokenJson.error_description ?? tokenJson.error ?? "unknown";
    logger.error("GitHub token exchange failed", { status: tokenRes.status, error: ghError });
    return NextResponse.json({ message: "Token exchange failed", error: ghError }, { status: 500 });
  }

  const { access_token, scope } = tokenJson;

  // Upsert integration record for the platform (avoids duplicate rows)
  let integration = await getUserIntegrationByPlatform(userId, platform);
  if (!integration) {
    integration = await createIntegration({ userId, platform, permissions: "read", metadata: JSON.stringify({ provider: "github" }) });
  }

  // Fetch GitHub account info and store name/email/avatar
  const userInfo = await fetchGitHubUserInfo(access_token);
  if (userInfo) {
    const accountName = userInfo.name ?? userInfo.login ?? null;
    const accountEmail = userInfo.email ?? null;
    await db
      .update(integrations)
      .set({
        accountEmail,
        accountName,
        metadata: JSON.stringify({
          provider: "github",
          accountEmail,
          accountName,
          avatarUrl: userInfo.avatar_url ?? null,
        }),
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, integration.id));
    logger.info("GitHub account info stored", { email: accountEmail, platform, integrationId: integration.id });
  }

  // Upsert oauth_tokens (GitHub OAuth App tokens are non-expiring; no refresh token issued)
  const existing = await db.select().from(oauthTokens).where(eq(oauthTokens.integrationId, integration.id)).limit(1);
  if (existing.length > 0) {
    await db.update(oauthTokens).set({ accessToken: access_token, refreshToken: null, scope, expiresAt: null, updatedAt: new Date() }).where(eq(oauthTokens.integrationId, integration.id)).returning();
  } else {
    await db.insert(oauthTokens).values({ integrationId: integration.id, accessToken: access_token, refreshToken: null, scope, expiresAt: null }).returning();
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
      details: `Successfully connected via GitHub OAuth`,
      integrationId: integration.id,
      metadata: { scopes: scope },
    });
  } catch (logErr) {
    logger.debug("Failed to log activity", { error: String(logErr) });
  }

  logger.info("GitHub OAuth connected", { userId, platform, integrationId: integration.id });

  const redirectUrl = new URL(next, request.url);
  return NextResponse.redirect(redirectUrl);
}
