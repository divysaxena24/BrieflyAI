import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import crypto from "crypto";
import querystring from "querystring";
import { db, oauthTokens } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getUserIntegrationByPlatform, updateIntegrationStatus } from "@/lib/db/queries";
import type { Provider, ConnectParams, ConnectResult, DisconnectParams, DisconnectResult, StatusResult, RefreshResult } from "./types";
import tokenManager from "./githubTokenManager";

/**
 * GitHubProvider implements Provider interface for GitHub OAuth.
 * This implementation performs only OAuth connect/disconnect/status orchestration.
 * It does NOT call GitHub API endpoints (repos, PRs, issues, commits).
 */
export class GitHubProvider implements Provider {
  id = "github"; // provider id for GitHub account connections
  displayName = "GitHub";
  capabilities = { supportsDisconnect: true, supportsRefresh: false, requiresOAuth: true };

  async validateConfiguration(): Promise<boolean> {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    const redirectUri = process.env.GITHUB_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      logger.warn("GitHubProvider.validateConfiguration: missing env vars");
      return false;
    }
    return true;
  }

  async connect(_params: ConnectParams): Promise<ConnectResult> {
    if (!(await this.validateConfiguration())) {
      throw new AppError("GitHub OAuth configuration is missing", 500, "missing_config");
    }

    const clientId = process.env.GITHUB_CLIENT_ID!;
    const redirectUri = process.env.GITHUB_REDIRECT_URI!;

    // GitHub classic OAuth App scopes:
    // - "repo"      : full access to repos (incl. private) — needed to read PRs/issues/commits
    //                 across projects. NOTE: GitHub has no read-only repo scope; use
    //                 "public_repo" instead if only public repositories are required.
    // - "read:user" : read profile (name, avatar)
    // - "user:email": read the user's email addresses
    const scope = [
      "repo",
      "read:user",
      "user:email",
    ].join(" ");

    const state = crypto.randomBytes(16).toString("hex");

    const params: Record<string, string> = {
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state,
      // Prevent account sign-up during connect; users must already have a GitHub account.
      allow_signup: "false",
    };

    const authUrl = `https://github.com/login/oauth/authorize?${querystring.stringify(params)}`;

    return { success: true, message: "Redirect to GitHub OAuth", payload: { authUrl, state } };
  }

  async disconnect(params: DisconnectParams): Promise<DisconnectResult> {
    try {
      await updateIntegrationStatus(params.integrationId, "not-connected");
      logger.info("GitHubProvider.disconnect: integration marked not-connected", { integrationId: params.integrationId });
      return { success: true, message: "Integration marked disconnected." };
    } catch (err) {
      logger.error("GitHubProvider.disconnect failed", { error: err, integrationId: params.integrationId });
      throw new AppError("Failed to disconnect integration", 500, "disconnect_failed");
    }
  }

  async status(userId: string, platform: string): Promise<StatusResult> {
    logger.debug("GitHubProvider.status called", { userId, platform });

    try {
      // Resolve the integration row for the requested platform (e.g., "github").
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
      // GitHub OAuth App tokens are non-expiring by default (expiresAt is null),
      // so tokenManager.isExpired/expiresSoon treat a missing expiry as VALID.
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
      logger.warn("GitHubProvider.status failed", { error: String(err) });
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
      // GitHub OAuth App tokens are non-expiring and the token endpoint does not issue
      // refresh tokens; refreshToken() intentionally throws not_implemented.
      await tokenManager.refreshToken(integrationId);
      logger.info("GitHubProvider.refresh: token refresh successful", { integrationId });
      return { success: true, message: "Token refreshed" };
    } catch (err) {
      logger.warn("GitHubProvider.refresh failed", { integrationId, error: String(err) });
      if (err instanceof AppError) throw err;
      throw new AppError("Token refresh failed", 502, "refresh_failed");
    }
  }
}

export default GitHubProvider;
