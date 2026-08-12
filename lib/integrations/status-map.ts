import type { ConnectionStatus } from "./types";

/**
 * Maps a raw `integrations.status` value (as stored in the database) onto the
 * frontend `ConnectionStatus` union.
 *
 * The DB column is a free-form `text` field with no check constraint, so any
 * string can end up there. The token managers write the snake_case value
 * `needs_reconnect` when a session can no longer be refreshed; the UI contract
 * uses kebab-case ("needs-reconnect"), so the value is canonicalized here.
 *
 * Anything that is not a known status maps deterministically to "error" so the
 * UI surfaces an unexpected/broken state instead of receiving an out-of-contract
 * value that has no badge styling.
 */
const DB_STATUS_TO_CONNECTION_STATUS: Record<string, ConnectionStatus> = {
  connected: "connected",
  "not-connected": "not-connected",
  needs_reconnect: "needs-reconnect",
};

export function mapDbStatusToConnectionStatus(dbStatus: string): ConnectionStatus {
  return DB_STATUS_TO_CONNECTION_STATUS[dbStatus] ?? "error";
}
