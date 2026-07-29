import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { Provider, ConnectParams, ConnectResult, DisconnectParams, DisconnectResult, StatusResult, RefreshResult } from "./types";

/**
 * Default provider stub used as a placeholder for real provider implementations.
 * All methods return deterministic placeholder responses so orchestration can be
 * exercised and integrated without provider-specific OAuth or API calls.
 */
export class DefaultProvider implements Provider {
  id: string;
  displayName?: string;
  capabilities = {
    supportsDisconnect: true,
    supportsRefresh: false,
    requiresOAuth: false,
  };

  constructor(id: string, displayName?: string) {
    this.id = id;
    this.displayName = displayName ?? id;
  }

  async validateConfiguration(_config?: Record<string, unknown>): Promise<boolean> {
    // No provider-specific validation for the stub
    return true;
  }

  async connect(params: ConnectParams): Promise<ConnectResult> {
    logger.debug("DefaultProvider.connect called", { provider: this.id, platform: params.platform, userId: params.userId });
    // Return a placeholder response. Real providers will return redirect URLs or tokens.
    return {
      success: true,
      message: `Placeholder connect for provider ${this.id}`,
      payload: { placeholder: true },
    };
  }

  async disconnect(_params: DisconnectParams): Promise<DisconnectResult> {
    logger.debug("DefaultProvider.disconnect called", { provider: this.id });
    return { success: true, message: `Placeholder disconnect for provider ${this.id}` };
  }

  async status(_userId: string, platform: string): Promise<StatusResult> {
    logger.debug("DefaultProvider.status called", { provider: this.id, platform });
    return {
      provider: this.id,
      status: "not-connected",
      lastSync: null,
      expiresAt: null,
      needsReconnect: false,
      connectionHealth: "failed",
      meta: { placeholder: true },
    } as StatusResult;
  }

  async refresh(_params: { integrationId: string }): Promise<RefreshResult> {
    // Refresh is intentionally not implemented for the stub. Signal using AppError.
    throw new AppError("Provider refresh not implemented", 501, "not_implemented");
  }
}

export default DefaultProvider;