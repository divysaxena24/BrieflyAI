/**
 * DiscordTokenManager regression tests.
 *
 * Root cause covered: a Discord session with a missing/invalid refresh token
 * used to surface a cryptic "Refresh token missing" 401 and, worse, the service
 * wiped the token row on 401 (destroying the refresh token). The manager must
 * instead mark the integration needs_reconnect and throw a clean, standardized
 * reconnect_required error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => {
  const oauthTokens = {
    integrationId: "integrationId",
    accessToken: "accessToken",
    refreshToken: "refreshToken",
    expiresAt: "expiresAt",
    updatedAt: "updatedAt",
    scope: "scope",
  };
  const db = {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) })),
    update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) })),
    insert: vi.fn(() => ({ values: () => ({ returning: async () => [] }) })),
  };
  return { db, oauthTokens };
});

vi.mock("@/lib/db/queries", () => ({
  updateIntegrationStatus: vi.fn(async () => undefined),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Provide dummy Discord client credentials for tests so the refresh flow
// proceeds to call the token endpoint (tests mock fetch responses).
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "test-client-id";
process.env.DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "test-client-secret";

import { db } from "@/lib/db";
import { updateIntegrationStatus } from "@/lib/db/queries";
import discordTokenManager from "@/lib/services/integrations/discordTokenManager";

/** Point db.select() at a fixed token row. */
function mockTokenRow(row: Record<string, unknown>) {
  (db.select as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: async () => [row] }) }),
  }));
}

describe("DiscordTokenManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws a clean reconnect_required error when the refresh token is missing", async () => {
    mockTokenRow({ accessToken: "stale", refreshToken: null, expiresAt: null });

    await expect(discordTokenManager.refreshToken("int-1")).rejects.toMatchObject({
      code: "reconnect_required",
      status: 401,
    });
    // The integration is marked as needing reconnection so the UI surfaces it.
    expect(updateIntegrationStatus).toHaveBeenCalledWith("int-1", "needs_reconnect");
  });

  it("throws authentication_required (invalid_grant) and marks needs_reconnect when refresh is rejected", async () => {
    mockTokenRow({ accessToken: "stale", refreshToken: "rt", expiresAt: new Date(Date.now() - 1000) });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    try {
      await expect(discordTokenManager.refreshToken("int-1")).rejects.toMatchObject({
        code: "authentication_required",
        status: 401,
      });
      expect(updateIntegrationStatus).toHaveBeenCalledWith("int-1", "needs_reconnect");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rotates and persists the new refresh token on a successful refresh", async () => {
    mockTokenRow({ accessToken: "stale", refreshToken: "old-rt", expiresAt: new Date(Date.now() - 1000) });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 604800, scope: "identify guilds" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    try {
      const result = await discordTokenManager.refreshToken("int-1");
      expect(result.access_token).toBe("new-at");
      const updateCall = (db.update as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(updateCall).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getValidAccessToken surfaces reconnect_required when the stored token is unusable", async () => {
    mockTokenRow({ accessToken: "stale", refreshToken: null, expiresAt: null });

    await expect(discordTokenManager.getValidAccessToken("int-1")).rejects.toMatchObject({
      code: "reconnect_required",
      status: 401,
    });
  });

  it("deduplicates concurrent refreshes (single-flight, safe token rotation)", async () => {
    mockTokenRow({ accessToken: "stale", refreshToken: "rt", expiresAt: new Date(Date.now() - 1000) });

    const originalFetch = globalThis.fetch;
    let resolveFetch: ((value: Response) => void) | null = null;
    let fetchCount = 0;
    globalThis.fetch = vi.fn(() => {
      fetchCount += 1;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    }) as unknown as typeof fetch;

    try {
      // Two concurrent 401s trigger two refreshes with the SAME refresh token.
      // Discord rotates it, so the loser would get invalid_grant → false
      // needs_reconnect. The manager must share one in-flight refresh.
      const p1 = discordTokenManager.refreshToken("int-1");
      const p2 = discordTokenManager.refreshToken("int-1");
      await new Promise((r) => setTimeout(r, 0)); // let doRefresh reach fetch

      resolveFetch?.(
        new Response(JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 604800 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.access_token).toBe("new-at");
      expect(r2.access_token).toBe("new-at");
      expect(fetchCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("allows a fresh refresh after the in-flight one settles (slot is released)", async () => {
    mockTokenRow({ accessToken: "stale", refreshToken: "rt", expiresAt: new Date(Date.now() - 1000) });

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 604800 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    try {
      await discordTokenManager.refreshToken("int-1");
      await discordTokenManager.refreshToken("int-1");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a still-valid stored access token without refreshing", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    mockTokenRow({ accessToken: "valid-at", refreshToken: "rt", expiresAt: future });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    try {
      const result = await discordTokenManager.getValidAccessToken("int-1");
      expect(result.accessToken).toBe("valid-at");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
