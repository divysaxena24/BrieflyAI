import { describe, expect, it } from "vitest";
import { mapDbStatusToConnectionStatus } from "@/lib/integrations/status-map";
import type { ConnectionStatus } from "@/lib/integrations/types";
import { getConnectionBadgeConfig } from "@/components/integrations/ConnectionBadge";

// Every member of the frontend ConnectionStatus union. Keeping this list
// explicit means adding a new member without a badge config fails loudly here
// even if the component's own Record type were ever loosened.
const ALL_CONNECTION_STATUSES: ConnectionStatus[] = [
  "not-connected",
  "connecting",
  "connected",
  "disconnecting",
  "syncing",
  "error",
  "token-expired",
  "needs-reconnect",
];

describe("mapDbStatusToConnectionStatus", () => {
  it("maps every known DB status onto the frontend contract", () => {
    expect(mapDbStatusToConnectionStatus("not-connected")).toBe("not-connected");
    expect(mapDbStatusToConnectionStatus("connected")).toBe("connected");
    // Token managers write snake_case; the UI contract is kebab-case.
    expect(mapDbStatusToConnectionStatus("needs_reconnect")).toBe("needs-reconnect");
  });

  it("maps unknown/runtime statuses deterministically to error instead of leaking them", () => {
    expect(mapDbStatusToConnectionStatus("disconnected")).toBe("error");
    expect(mapDbStatusToConnectionStatus("pending")).toBe("error");
    expect(mapDbStatusToConnectionStatus("revoked")).toBe("error");
    expect(mapDbStatusToConnectionStatus("")).toBe("error");
    expect(mapDbStatusToConnectionStatus("SOME_LEGACY_VALUE")).toBe("error");
  });
});

describe("ConnectionBadge status config", () => {
  it("defines a badge config with an icon for every ConnectionStatus member", () => {
    for (const status of ALL_CONNECTION_STATUSES) {
      const config = getConnectionBadgeConfig(status);
      expect(config, `missing badge config for "${status}"`).toBeDefined();
      expect(config.icon, `missing icon for "${status}"`).toBeDefined();
      expect(config.label, `missing label for "${status}"`).toBeTruthy();
    }
  });

  it("returns a safe fallback (never undefined) for unknown runtime statuses", () => {
    const config = getConnectionBadgeConfig("needs_reconnect" as ConnectionStatus);
    expect(config).toBeDefined();
    expect(config.icon).toBeDefined();
    expect(config.label).toBeTruthy();

    const fallback = getConnectionBadgeConfig("totally-bogus" as ConnectionStatus);
    expect(fallback).toBeDefined();
    expect(fallback.icon).toBeDefined();
    expect(fallback.label).toBe("Unknown");
  });
});
