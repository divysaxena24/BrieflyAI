import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import crypto from "crypto";
import querystring from "querystring";
import { db, oauthTokens } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getUserIntegrationByPlatform, updateIntegrationStatus } from "@/lib/db/queries";
import type { Provider, ConnectParams, ConnectResult, DisconnectParams, DisconnectResult, StatusResult, RefreshResult } from "./types";
import discordTokenManager from "./discordTokenManager";

/**
 * DiscordProvider implements Provider interface for Discord OAuth2.
 * This implementation performs only OAuth connect/disconnect/status orchestration.
 * It does NOT call Discord API endpoints (guilds, channels, messages).
 */

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
    try {
      await discordTokenManager.refreshToken(integrationId);
      logger.info("DiscordProvider.refresh: token refresh successful", { integrationId });
      return { success: true, message: "Token refreshed" };
    } catch (err) {
      logger.warn("DiscordProvider.refresh failed", { integrationId, error: String(err) });
      if (err instanceof AppError) throw err;
      throw new AppError("Token refresh failed", 502, "refresh_failed");
    }
  }
}

export default DiscordProvider;
