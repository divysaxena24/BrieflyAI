import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import crypto from "crypto";
import querystring from "querystring";
import { db, oauthTokens } from "@/lib/db";
import { eq } from "drizzle-orm";
import { createIntegration, getUserIntegrationByPlatform, updateIntegrationStatus } from "@/lib/db/queries";
import type { Provider, ConnectParams, ConnectResult, DisconnectParams, DisconnectResult, StatusResult, RefreshResult } from "./types";
import tokenManager from "./googleTokenManager";

/**
 * GoogleProvider implements Provider interface for Google OAuth (Gmail/Calendar/Drive groups).
 * This implementation performs only OAuth connect/disconnect/status orchestration.
 * It does NOT call Gmail/Calendar/Drive APIs.
 */
export class GoogleProvider implements Provider {
  id = "google"; // provider id for Google account connections
  displayName = "Google (Account)";
  capabilities = { supportsDisconnect: true, supportsRefresh: true, requiresOAuth: true };

  async validateConfiguration(): Promise<boolean> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      logger.warn("GoogleProvider.validateConfiguration: missing env vars");
      return false;
    }
    return true;
  }

  async connect(_params: ConnectParams): Promise<ConnectResult> {
    if (!(await this.validateConfiguration())) {
      throw new AppError("Google OAuth configuration is missing", 500, "missing_config");
    }

    const clientId = process.env.GOOGLE_CLIENT_ID!;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI!;

    const scope = ["openid", "email", "profile"].join(" ");
    const state = crypto.randomBytes(16).toString("hex");

    const params: Record<string, string> = {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    };

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${querystring.stringify(params)}`;

    return { success: true, message: "Redirect to Google OAuth", payload: { authUrl, state } };
  }

  async disconnect(params: DisconnectParams): Promise<DisconnectResult> {
    try {
      await updateIntegrationStatus(params.integrationId, "not-connected");
      logger.info("GoogleProvider.disconnect: integration marked not-connected", { integrationId: params.integrationId });
      return { success: true, message: "Integration marked disconnected." };
    } catch (err) {
      logger.error("GoogleProvider.disconnect failed", { error: err, integrationId: params.integrationId });
      throw new AppError("Failed to disconnect integration", 500, "disconnect_failed");
    }
  }

  async status(userId: string, _platform: string): Promise<StatusResult> {
    logger.debug("GoogleProvider.status called", { userId });

    try {
      const integration = await getUserIntegrationByPlatform(userId, this.id);
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
      const tokenExpired = token ? tokenManager.isExpired(expiresAt) : false;
      const soon = token ? tokenManager.expiresSoon(expiresAt) : false;
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
      logger.warn("GoogleProvider.status failed", { error: String(err) });
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
      await tokenManager.refreshToken(integrationId);
      logger.info("GoogleProvider.refresh: token refresh successful", { integrationId });
      return { success: true, message: "Token refreshed" };
    } catch (err) {
      logger.warn("GoogleProvider.refresh failed", { integrationId, error: String(err) });
      if (err instanceof AppError) throw err;
      throw new AppError("Token refresh failed", 502, "refresh_failed");
    }
  }
}

export default GoogleProvider;