import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getUserIntegrationByPlatform, createIntegration, logActivity } from "@/lib/db/queries";
import type { WhatsAppSessionInfo } from "@/lib/services/whatsapp/whatsappSessionManager";
import type { Provider, ConnectParams, ConnectResult, DisconnectParams, DisconnectResult, StatusResult, RefreshResult, ConnectionStatus } from "./types";

/**
 * Load the WhatsApp session manager lazily.
 *
 * The session-manager module statically imports Baileys (ESM-only), so
 * Turbopack compiles it — and any module that statically imports it — as an
 * async module. The registry loads providers with a synchronous require();
 * requiring an async module returns a Promise (not the exports), so
 * `.WhatsAppProvider` would be undefined and `new WhatsAppProvider()` would
 * throw "WhatsAppProvider is not a constructor". Loading the manager via a
 * dynamic import keeps this provider synchronously loadable — exactly like the
 * Telegram/GitHub/Google providers. The dynamic import is cached, so every
 * call returns the same singleton namespace.
 */
async function loadSessionManager() {
  const mod = await import("@/lib/services/whatsapp/whatsappSessionManager");
  return mod.whatsappSessionManager;
}

/**
 * WhatsAppProvider implements the Provider interface for WhatsApp via Baileys.
 *
 * WhatsApp uses QR-code (or pairing-code) session authentication — NO OAuth,
 * NO redirect, NO callback, NO state cookie, and NO server-side credentials.
 * The user scans a QR code with their phone; the connection state is owned by
 * the WhatsAppSessionManager and surfaced through status().
 *
 * The integration is only marked "connected" AFTER the QR code is scanned —
 * connect() merely starts the session and returns its state.
 */
export class WhatsAppProvider implements Provider {
  id = "whatsapp"; // provider id for WhatsApp account connections
  displayName = "WhatsApp";
  capabilities = {
    supportsDisconnect: true,
    supportsRefresh: false,
    requiresOAuth: false,
  };

  async validateConfiguration(): Promise<boolean> {
    // WhatsApp uses per-user Baileys sessions — no server-side client
    // credentials are required (unlike Google/GitHub/Discord OAuth).
    logger.debug("WhatsAppProvider.validateConfiguration: no server-side config required");
    return true;
  }

  async connect(params: ConnectParams): Promise<ConnectResult> {
    const platform = params.platform || this.id;

    // Create the integration row on first connect (avoids duplicate rows).
    // No account info yet — that is resolved from the QR scan later.
    let integration = await getUserIntegrationByPlatform(params.userId, platform);
    if (!integration) {
      integration = await createIntegration({
        userId: params.userId,
        platform,
        permissions: "read",
        accountEmail: undefined,
        accountName: undefined,
        metadata: JSON.stringify({ provider: "whatsapp", phase: "pending-scan" }),
      });
    }

    // Start the Baileys session. Idempotent — an already-running session is
    // returned as-is. We do NOT wait for the QR scan here.
    const whatsappSessionManager = await loadSessionManager();
    const info = await whatsappSessionManager.createSession(integration.id);

    logger.info("WhatsAppProvider.connect: session started", {
      userId: params.userId,
      integrationId: integration.id,
      state: info.state,
    });

    // The integration is intentionally NOT marked connected here — that only
    // happens after the QR code is scanned (status() maps the session to the
    // UI state, and a later flow finalizes the connection).
    return {
      success: true,
      message: "WhatsApp session started — scan the QR code to connect",
      payload: {
        integrationId: integration.id,
        sessionId: integration.id,
        state: info.state,
      },
    };
  }

  async disconnect(params: DisconnectParams): Promise<DisconnectResult> {
    const { userId, integrationId } = params;
    try {
      // Log out of WhatsApp and delete the persisted session. Best-effort —
      // the session may already be gone (e.g. after a server restart).
      const whatsappSessionManager = await loadSessionManager();
      try {
        await whatsappSessionManager.removeSession(integrationId);
      } catch (err) {
        logger.warn("WhatsAppProvider.disconnect: session cleanup failed", { integrationId, error: String(err) });
      }

      // Log the disconnection activity asynchronously — never block the response
      logActivity({
        userId,
        platform: this.id,
        action: "Disconnected WhatsApp",
        details: "WhatsApp integration disconnected by user",
        integrationId,
      }).catch((e) => logger.debug("logActivity failed", { error: String(e) }));

      logger.info("WhatsAppProvider.disconnect: integration marked not-connected", { integrationId });
      return { success: true, message: "WhatsApp disconnected." };
    } catch (err) {
      logger.error("WhatsAppProvider.disconnect failed", { error: err, integrationId });
      throw new AppError("Failed to disconnect WhatsApp integration", 500, "disconnect_failed");
    }
  }

  async status(userId: string, platform: string): Promise<StatusResult> {
    logger.debug("WhatsAppProvider.status called", { userId, platform });

    try {
      const integration = await getUserIntegrationByPlatform(userId, platform || this.id);
      if (!integration) {
        return this.notConnectedResult();
      }

      // The session manager is the source of truth while a session is in memory
      const whatsappSessionManager = await loadSessionManager();
      const info = whatsappSessionManager.getConnectionState(integration.id);
      if (!info) {
        // No in-memory session (e.g. after a server restart) — report the DB row
        return {
          provider: this.id,
          status: integration.status as ConnectionStatus,
          lastSync: integration.lastSyncAt ? integration.lastSyncAt.toISOString() : null,
          connectionHealth: integration.status === "connected" ? "healthy" : "failed",
          meta: { inMemorySession: false },
        } as StatusResult;
      }

      const mapped = this.mapSessionState(info);
      return {
        provider: this.id,
        status: mapped.status,
        lastSync: integration.lastSyncAt ? integration.lastSyncAt.toISOString() : null,
        // Prompt the user to re-scan when logged out OR when auto-reconnect gave up
        needsReconnect: info.state === "logged-out" || info.lastDisconnectReason === "reconnect-failed",
        connectionHealth: mapped.health,
        meta: { sessionState: info.state, lastDisconnectReason: info.lastDisconnectReason },
      } as StatusResult;
    } catch (err) {
      logger.warn("WhatsAppProvider.status failed", { error: String(err) });
      return this.notConnectedResult();
    }
  }

  async refresh(params: { integrationId: string }): Promise<RefreshResult> {
    const { integrationId } = params;
    // WhatsApp sessions are non-expiring and cannot be refreshed — there is no
    // refresh-token mechanism (mirrors Telegram bot tokens).
    logger.warn("WhatsAppProvider.refresh: not supported (sessions are non-expiring)", { integrationId });
    throw new AppError("WhatsApp sessions cannot be refreshed.", 501, "not_implemented");
  }

  // ── Helpers ────────────────────────────────

  /**
   * Map a session-manager state into the integration status model.
   * - open            → connected
   * - qr / connecting → connecting (waiting for the QR scan / reconnect)
   * - close           → error when reconnect was given up, else connecting
   * - logged-out      → not-connected (a fresh scan is required)
   */
  private mapSessionState(info: WhatsAppSessionInfo): { status: ConnectionStatus; health: "healthy" | "degraded" | "failed" } {
    switch (info.state) {
      case "open":
        return { status: "connected", health: "healthy" };
      case "qr":
      case "connecting":
        return { status: "connecting", health: "degraded" };
      case "close":
        return info.lastDisconnectReason === "reconnect-failed"
          ? { status: "error", health: "failed" }
          : { status: "connecting", health: "degraded" };
      case "logged-out":
        return { status: "not-connected", health: "failed" };
    }
  }

  private notConnectedResult(): StatusResult {
    return {
      provider: this.id,
      status: "not-connected",
      lastSync: null,
      needsReconnect: false,
      connectionHealth: "failed",
      meta: null,
    } as StatusResult;
  }
}

export default WhatsAppProvider;
