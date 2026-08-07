
export type ProviderId = string; // e.g. 'gmail', 'github', 'discord'

export type ProviderConfiguration = Record<string, unknown>;

export type ProviderCapabilities = {
  supportsRefresh?: boolean;
  supportsDisconnect?: boolean;
  requiresOAuth?: boolean; // whether provider needs OAuth redirect flow
};

export type ConnectionStatus =
  | "not-connected"
  | "connecting"
  | "connected"
  | "syncing"
  | "error"
  | "token-expired";

export interface ConnectParams {
  userId: string;
  platform: string; // platform id (provider id)
  config?: ProviderConfiguration;
}

export interface ConnectResult {
  success: boolean;
  message?: string;
  // provider-level payload for next action (e.g. redirect url)
  payload?: Record<string, unknown> | null;
}

export interface DisconnectParams {
  userId: string;
  integrationId: string;
}

export interface DisconnectResult {
  success: boolean;
  message?: string;
}

export interface StatusResult {
  provider: string;
  status: ConnectionStatus;
  lastSync?: string | null;
  expiresAt?: string | null;
  needsReconnect?: boolean;
  connectionHealth?: "healthy" | "degraded" | "failed";
  meta?: Record<string, unknown> | null;
}

export interface RefreshResult {
  success: boolean;
  message?: string;
}

/** Minimal provider interface every provider must implement. */
export interface Provider {
  id: ProviderId;
  displayName?: string;
  capabilities?: ProviderCapabilities;

  validateConfiguration(config?: ProviderConfiguration): Promise<boolean>;

  connect(params: ConnectParams): Promise<ConnectResult>;

  disconnect(params: DisconnectParams): Promise<DisconnectResult>;

  status(userId: string, platform: string): Promise<StatusResult>;

  refresh(params: { integrationId: string }): Promise<RefreshResult>;
}
