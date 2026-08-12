export type ConnectionStatus =
  | "not-connected"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "syncing"
  | "error"
  | "token-expired"
  | "needs-reconnect";

export type AuthType = "google-oauth" | "oauth" | "bot-token";

export interface SyncInfo {
  lastSync: string | null;
  status: "idle" | "syncing" | "error";
  error: string | null;
}

export interface McpTool {
  id: string;
  name: string;
  description: string;
}

export interface IntegrationConfig {
  id: string;
  name: string;
  description: string;
  category: string;
  authenticationType: AuthType;
  status: ConnectionStatus;
  permissions: string;
  lastSync: string | null;
  account: string | null;
  /** Space-separated OAuth scope string from oauth_tokens */
  scopes?: string | null;
  /** Hex color or Tailwind gradient key used for the platform accent */
  accentColor: string;
}

/** Error state variants shared across the integration UI */
export type IntegrationError =
  | "oauth-failure"
  | "connection-failed"
  | "permission-revoked"
  | "network-error"
  | "token-expired";
