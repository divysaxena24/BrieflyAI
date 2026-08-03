import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import crypto from "crypto";
import querystring from "querystring";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { db, oauthTokens } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getUserIntegrationByPlatform, updateIntegrationStatus } from "@/lib/db/queries";
import type { Provider, ConnectParams, ConnectResult, DisconnectParams, DisconnectResult, StatusResult, RefreshResult } from "./types";

/**
 * DiscordProvider implements Provider interface for Discord OAuth2.
 * This implementation performs only OAuth connect/disconnect/status orchestration.
 * It does NOT call Discord API endpoints (guilds, channels, messages).
 */

// ─────────────────────────────────────────────────────────────
//  DIAGNOSTIC ONLY — remove once the "Invalid OAuth2 redirect_uri"
//  investigation is complete. Proves which env file supplies each
//  DISCORD_* value. Never logs the client secret or tokens.
// ─────────────────────────────────────────────────────────────
const ENV_FILES_IN_PRECEDENCE_ORDER = [".env.development.local", ".env.local", ".env.development", ".env"];
const DISCORD_ENV_KEYS = ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_REDIRECT_URI"];

function detectDiscordEnvFiles(): {
  files: Record<string, { exists: boolean; defines: string[] }>;
  winners: Record<string, string>;
} {
  const files: Record<string, { exists: boolean; defines: string[] }> = {};
  for (const file of ENV_FILES_IN_PRECEDENCE_ORDER) {
    const p = join(process.cwd(), file);
    if (!existsSync(p)) {
      files[file] = { exists: false, defines: [] };
      continue;
    }
    const raw = readFileSync(p, "utf8");
    const defines = DISCORD_ENV_KEYS.filter((key) => new RegExp(`^\\s*${key}\\s*=`, "m").test(raw));
    files[file] = { exists: true, defines };
  }
  const winners: Record<string, string> = {};
  for (const key of DISCORD_ENV_KEYS) {
    const winner = ENV_FILES_IN_PRECEDENCE_ORDER.find((file) => files[file].defines.includes(key));
    winners[key] = winner ?? "(not defined in any env file)";
  }
  return { files, winners };
}

export class DiscordProvider implements Provider {
  id = "discord"; // provider id for Discord account connections
  displayName = "Discord";
  capabilities = { supportsDisconnect: true, supportsRefresh: true, requiresOAuth: true };

  async validateConfiguration(): Promise<boolean> {
    const clientId = process.env.DISCORD_CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    const redirectUri = process.env.DISCORD_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      logger.warn("DiscordProvider.validateConfiguration: missing env vars");
      return false;
    }
    return true;
  }

  async connect(_params: ConnectParams): Promise<ConnectResult> {
    if (!(await this.validateConfiguration())) {
      throw new AppError("Discord OAuth configuration is missing", 500, "missing_config");
    }

    const clientId = process.env.DISCORD_CLIENT_ID!;
    // RAW value — sent to Discord exactly as loaded from the environment.
    const redirectUri = process.env.DISCORD_REDIRECT_URI!;

    // Discord OAuth2 scopes:
    // - "identify": read the user's username, avatar, and discriminator
    // - "email"   : read the user's email address
    // - "guilds"  : read the user's guild (server) list — needed for the
    //               "Read Channels" feature
    const scope = ["identify", "email", "guilds"].join(" ");

    const state = crypto.randomBytes(16).toString("hex");

    const params: Record<string, string> = {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope,
      state,
    };

    const authUrl = `https://discord.com/oauth2/authorize?${querystring.stringify(params)}`;

    // ─── DIAGNOSTIC INSTRUMENTATION (temporary) ───
    // Proves exactly what this process sends to Discord. The redirect_uri is
    // logged decoded so it can be compared char-by-char with the Developer
    // Portal → OAuth2 → General → "Redirects" entry.
    const envFiles = detectDiscordEnvFiles();
    // Raw-string facts are computed first so they are never lost, even if the
    // URL itself fails to parse.
    const breakdown: Record<string, string | number | boolean> = {
      length: redirectUri.length,
      trailingSlash: redirectUri.endsWith("/"),
      hasWhitespace: /\s/.test(redirectUri),
      hasQuery: redirectUri.includes("?"),
      hasHash: redirectUri.includes("#"),
      isLowerCase: redirectUri === redirectUri.toLowerCase(),
    };
    try {
      const parsed = new URL(redirectUri);
      breakdown.protocol = parsed.protocol;
      breakdown.hostname = parsed.hostname;
      breakdown.port = parsed.port || "(default)";
      breakdown.pathname = parsed.pathname;
    } catch {
      breakdown.parseFailed = true;
    }
    logger.info("[discord-diag] cwd + mode", { cwd: process.cwd(), nodeEnv: process.env.NODE_ENV ?? "(unset)" });
    logger.info(
      "[discord-diag] env files (Next.js precedence: .env.development.local > .env.local > .env.development > .env)",
      envFiles,
    );
    logger.info("[discord-diag] DISCORD_CLIENT_ID", { clientId });
    logger.info("[discord-diag] DISCORD_REDIRECT_URI (raw, decoded)", { redirectUri });
    logger.info("[discord-diag] authorize URL (encoded, as sent to Discord)", { authUrl });
    logger.info("[discord-diag] OAuth params as Discord receives them (decoded)", {
      client_id: params.client_id,
      redirect_uri: params.redirect_uri,
      scope: params.scope,
      response_type: params.response_type,
    });
    logger.info("[discord-diag] redirect_uri structural breakdown", { breakdown });

    return { success: true, message: "Redirect to Discord OAuth", payload: { authUrl, state } };
  }

  async disconnect(params: DisconnectParams): Promise<DisconnectResult> {
    try {
      await updateIntegrationStatus(params.integrationId, "not-connected");
      logger.info("DiscordProvider.disconnect: integration marked not-connected", { integrationId: params.integrationId });
      return { success: true, message: "Integration marked disconnected." };
    } catch (err) {
      logger.error("DiscordProvider.disconnect failed", { error: err, integrationId: params.integrationId });
      throw new AppError("Failed to disconnect integration", 500, "disconnect_failed");
    }
  }

  async status(userId: string, platform: string): Promise<StatusResult> {
    logger.debug("DiscordProvider.status called", { userId, platform });

    try {
      // Resolve the integration row for the requested platform (e.g., "discord").
      const integration = await getUserIntegrationByPlatform(userId, platform || this.id);
      if (!integration) {
        return {
          provider: this.id,
          status: "not-connected",
          connected: false,
          tokenExpired: false,
          expiresSoon: false,
          needsReconnect: false,
          lastRefresh: null,
          lastSync: null,
          connectionHealth: "failed",
          meta: null,
        } as StatusResult;
      }

      const tokenRow = await db.select().from(oauthTokens).where(eq(oauthTokens.integrationId, integration.id)).limit(1);
      const token = tokenRow[0] ?? null;

      const expiresAt = token?.expiresAt ?? null;
      // Discord OAuth2 access tokens are expiring (~7 days), like Google.
      // TODO(Discord): delegate these checks to DiscordTokenManager.isExpired()/
      // expiresSoon() once it is implemented (next step). Missing expiry = expired.
      const tokenExpired = token ? (expiresAt ? new Date(expiresAt).getTime() <= Date.now() : true) : false;
      const soon = token ? (expiresAt ? new Date(expiresAt).getTime() - Date.now() <= 60_000 : true) : false;
      const needsReconnect = token && tokenExpired;
      const lastRefresh = token?.updatedAt ? new Date(token.updatedAt).toISOString() : null;
      const lastSync = integration.lastSyncAt ? integration.lastSyncAt.toISOString() : null;
      const connectionHealth = needsReconnect ? "failed" : "healthy";

      return {
        provider: this.id,
        status: integration.status ?? (token ? "connected" : "not-connected"),
        connected: integration.status === "connected",
        tokenExpired,
        expiresSoon: soon,
        needsReconnect,
        lastRefresh,
        lastSync,
        connectionHealth,
        meta: integration.metadata ? JSON.parse(integration.metadata) : null,
      } as StatusResult;
    } catch (err) {
      logger.warn("DiscordProvider.status failed", { error: String(err) });
      return {
        provider: this.id,
        status: "not-connected",
        connected: false,
        tokenExpired: false,
        expiresSoon: false,
        needsReconnect: false,
        lastRefresh: null,
        lastSync: null,
        connectionHealth: "failed",
        meta: null,
      } as StatusResult;
    }
  }

  async refresh(params: { integrationId: string }): Promise<RefreshResult> {
    const { integrationId } = params;
    // Discord OAuth2 tokens are expiring and refreshable (unlike GitHub), so
    // this will delegate to DiscordTokenManager.refreshToken() once that manager
    // is implemented in a later step. Until then, refresh is intentionally
    // unsupported — no fabricated behavior.
    logger.warn("DiscordProvider.refresh: not yet implemented (DiscordTokenManager pending)", { integrationId });
    throw new AppError("Discord token refresh not yet implemented", 501, "not_implemented");
  }
}

export default DiscordProvider;
