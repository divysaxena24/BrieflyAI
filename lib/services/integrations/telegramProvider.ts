import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { db, integrations, oauthTokens } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getUserIntegrationByPlatform, createIntegration, updateIntegrationStatus, logActivity } from "@/lib/db/queries";
import type { Provider, ConnectParams, ConnectResult, DisconnectParams, DisconnectResult, StatusResult, RefreshResult } from "./types";

/** Minimal shape returned by Telegram's getMe(). */
interface TelegramBotInfo {
  id?: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

/**
 * Validate a Telegram bot token and resolve the bot's identity.
 * GET https://api.telegram.org/bot{token}/getMe — the token is embedded in the
 * URL path (Telegram has no Authorization-header convention for bots).
 * Response: { ok: true, result: { id, is_bot, first_name, username, ... } }
 * or { ok: false, error_code, description } (usually still HTTP 200).
 */
async function verifyBotToken(token: string): Promise<TelegramBotInfo> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  } catch (err) {
    logger.warn("TelegramProvider: getMe network failure", { error: String(err) });
    throw new AppError("Network error validating Telegram bot token", 502, "network_error");
  }

  const data = (await res.json().catch(() => {
    throw new AppError("Invalid response from Telegram API", 502, "invalid_provider_response");
  })) as {
    ok?: boolean;
    result?: TelegramBotInfo | null;
    error_code?: number;
    description?: string;
  };

  if (!data?.ok) {
    const errorCode = data?.error_code ?? 400;
    const description = data?.description ?? "Unknown error";
    logger.warn("TelegramProvider: getMe rejected the token", { errorCode, description });
    if (errorCode === 401) {
      throw new AppError("Invalid Telegram bot token", 401, "authentication_required");
    }
    throw new AppError(`Telegram bot token validation failed: ${description}`, errorCode, "telegram_error");
  }

  return data.result ?? {};
}

/**
 * TelegramProvider implements the Provider interface for Telegram Bot API.
 * This implementation performs token-entry connect/disconnect/status
 * orchestration. It does NOT call chat/message endpoints — those belong to
 * the Telegram HTTP service layer.
 *
 * Telegram uses Bot Token authentication:
 * - NO OAuth, NO redirect, NO callback, NO state cookie.
 * - The user supplies a bot token (from @BotFather) which is validated against
 *   getMe() and stored per-user.
 */
export class TelegramProvider implements Provider {
  id = "telegram"; // provider id for Telegram account connections
  displayName = "Telegram";
  capabilities = { supportsDisconnect: true, supportsRefresh: false, requiresOAuth: false };

  async validateConfiguration(): Promise<boolean> {
    // Telegram uses per-user Bot Tokens — no server-side client credentials are
    // required (unlike Google/GitHub/Discord OAuth). The token itself is
    // validated in connect() via getMe().
    logger.debug("TelegramProvider.validateConfiguration: no server-side config required");
    return true;
  }

  async connect(params: ConnectParams): Promise<ConnectResult> {
    if (!(await this.validateConfiguration())) {
      throw new AppError("Telegram configuration is missing", 500, "missing_config");
    }

    // The bot token is supplied by the user via params.config.token — there is
    // no OAuth redirect to generate.
    const rawToken = params.config?.token;
    if (typeof rawToken !== "string" || !rawToken.trim()) {
      throw new AppError("Telegram bot token is required", 400, "bad_request");
    }
    const token = rawToken.trim();

    // Validate the token and resolve the bot's identity via getMe()
    const botInfo = await verifyBotToken(token);
    const accountName = botInfo.username ? `@${botInfo.username}` : (botInfo.first_name ?? "Telegram bot");

    const platform = params.platform || this.id;
    const metadata = JSON.stringify({
      provider: "telegram",
      accountName,
      botId: botInfo.id ?? null,
    });

    // Create or update the integration row (avoids duplicate rows)
    let integration = await getUserIntegrationByPlatform(params.userId, platform);
    if (!integration) {
      integration = await createIntegration({
        userId: params.userId,
        platform,
        permissions: "read",
        accountName,
        metadata,
      });
    } else {
      await db
        .update(integrations)
        .set({ accountName, accountEmail: null, metadata, updatedAt: new Date() })
        .where(eq(integrations.id, integration.id));
    }

    // Mark connected
    await updateIntegrationStatus(integration.id, "connected");

    // Store the bot token (non-expiring — GitHub semantics: no refresh token)
    const existing = await db.select().from(oauthTokens).where(eq(oauthTokens.integrationId, integration.id)).limit(1);
    if (existing.length > 0) {
      await db
        .update(oauthTokens)
        .set({ accessToken: token, refreshToken: null, expiresAt: null, scope: null, updatedAt: new Date() })
        .where(eq(oauthTokens.integrationId, integration.id))
        .returning();
    } else {
      await db
        .insert(oauthTokens)
        .values({ integrationId: integration.id, accessToken: token, refreshToken: null, expiresAt: null, scope: null })
        .returning();
    }

    // Log the connection activity asynchronously — never block the response
    logActivity({
      userId: params.userId,
      platform,
      action: "Connected Telegram",
      details: `Connected Telegram bot ${accountName}`,
      integrationId: integration.id,
      metadata: { botId: botInfo.id ?? null },
    }).catch((e) => logger.debug("logActivity failed", { error: String(e) }));

    logger.info("TelegramProvider.connect: connected", { userId: params.userId, platform, accountName });

    return { success: true, message: "Telegram connected", payload: { accountName, botId: botInfo.id ?? null } };
  }

  async disconnect(params: DisconnectParams): Promise<DisconnectResult> {
    try {
      // Telegram has no token-revoke endpoint and the integration row is kept —
      // only the status is marked not-connected (mirrors GitHub/Discord).
      await updateIntegrationStatus(params.integrationId, "not-connected");
      logger.info("TelegramProvider.disconnect: integration marked not-connected", { integrationId: params.integrationId });
      return { success: true, message: "Integration marked disconnected." };
    } catch (err) {
      logger.error("TelegramProvider.disconnect failed", { error: err, integrationId: params.integrationId });
      throw new AppError("Failed to disconnect integration", 500, "disconnect_failed");
    }
  }

  async status(userId: string, platform: string): Promise<StatusResult> {
    logger.debug("TelegramProvider.status called", { userId, platform });

    try {
      // Resolve the integration row for the requested platform (e.g., "telegram").
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
      // Bot tokens never expire — a missing expiry means the token is still
      // valid (GitHub semantics, unlike Google/Discord which treat a missing
      // expiry as expired).
      const tokenExpired = token ? (expiresAt ? new Date(expiresAt).getTime() <= Date.now() : false) : false;
      const soon = token ? (expiresAt ? new Date(expiresAt).getTime() - Date.now() <= 60_000 : false) : false;
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
      logger.warn("TelegramProvider.status failed", { error: String(err) });
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
    // Telegram Bot API tokens are non-expiring and there is no refresh-token
    // mechanism — refresh is intentionally unsupported.
    logger.warn("TelegramProvider.refresh: not supported (bot tokens are non-expiring)", { integrationId });
    throw new AppError("Telegram bot tokens cannot be refreshed.", 501, "not_implemented");
  }
}

export default TelegramProvider;
