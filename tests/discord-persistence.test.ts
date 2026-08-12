/**
 * Discord persistence + post-refresh regression tests.
 *
 * Root cause covered: a Discord connection appeared "Connected" immediately
 * after OAuth, but a page refresh flipped it back to "Not Connected" / "Needs
 * Reconnect" and AI Discord tools returned 401. The contract that prevents
 * that is:
 *
 *   1. The OAuth callback persists the COMPLETE token set (access + refresh +
 *      expiry) and marks the integration `connected` BEFORE redirecting — the
 *      frontend "Connected" state is never allowed to be ahead of the DB.
 *   2. Integration status is derived from the persisted DB row on every page
 *      load, so a refresh (a fresh read of the same row) still reports
 *      connected.
 *   3. An expired access token with a still-valid refresh token is a
 *      recoverable session — the token manager refreshes on demand, and the
 *      status is not flipped to not-connected just because the access token
 *      expired.
 *   4. The AI Discord tools resolve the persisted integration and return real
 *      messages after a refresh (no stale in-memory state involved).
 *
 * No real Discord/Groq calls are made — Discord endpoints and the DB are
 * mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { DiscordProvider } from "@/lib/services/integrations/discordProvider";
import { DiscordClient } from "@/lib/services/discord/discordClient";
import { DiscordRecentMessagesTool } from "@/lib/ai/tools/discordTools";
import { GET as discordCallbackGET } from "@/app/api/integrations/discord-callback/route";

// ──────────────────────────────────────────────
//  Hoisted mocks (DB, queries, auth)
// ──────────────────────────────────────────────

const h = vi.hoisted(() => {
  const db = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  };
  const queries = {
    getUserIntegrationByPlatform: vi.fn(),
    createIntegration: vi.fn(),
    updateIntegrationStatus: vi.fn(async () => undefined),
    findUserByAuthId: vi.fn(),
    logActivity: vi.fn(async () => undefined),
    getCurrentUser: vi.fn(),
  };
  const state: {
    tokenRows: Array<Record<string, unknown>>;
    updates: Array<{ table: unknown; data: Record<string, unknown> }>;
    insertCalls: Array<Record<string, unknown>>;
  } = {
    tokenRows: [],
    updates: [],
    insertCalls: [],
  };
  return { db, queries, state };
});

vi.mock("@/lib/db", () => {
  const oauthTokens = {
    integrationId: "integrationId",
    accessToken: "accessToken",
    refreshToken: "refreshToken",
    expiresAt: "expiresAt",
    updatedAt: "updatedAt",
    scope: "scope",
  };
  const integrations = {
    id: "id",
    userId: "userId",
    platform: "platform",
    status: "status",
    permissions: "permissions",
    lastSyncAt: "lastSyncAt",
    metadata: "metadata",
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  };

  h.db.select.mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: async () => h.state.tokenRows }) }),
  }));
  h.db.update.mockImplementation((table: unknown) => ({
    set: (data: Record<string, unknown>) => {
      h.state.updates.push({ table, data });
      return { where: () => ({ returning: async () => [] }) };
    },
  }));
  h.db.insert.mockImplementation(() => ({
    values: (data: Record<string, unknown>) => {
      h.state.insertCalls.push(data);
      return { returning: async () => [] };
    },
  }));

  return { db: h.db, oauthTokens, integrations };
});

vi.mock("@/lib/db/queries", () => ({
  getUserIntegrationByPlatform: h.queries.getUserIntegrationByPlatform,
  createIntegration: h.queries.createIntegration,
  updateIntegrationStatus: h.queries.updateIntegrationStatus,
  findUserByAuthId: h.queries.findUserByAuthId,
  logActivity: h.queries.logActivity,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: h.queries.getCurrentUser,
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// ──────────────────────────────────────────────
//  Route-handler mocks (OAuth callback)
// ──────────────────────────────────────────────

vi.mock("@/lib/services/integrations/registry", () => ({
  registry: { bootstrapProviders: vi.fn() },
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "auth-1" } } })) },
  })),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: vi.fn(() => ({
      value: JSON.stringify({ state: "state-123", platform: "discord", next: "/dashboard/integrations/discord" }),
    })),
    delete: vi.fn(),
  })),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
    redirect: (url: URL | string) =>
      new Response(null, { status: 307, headers: { location: String(url) } }),
  },
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Mock the Discord token exchange + userinfo endpoints. */
function mockDiscordEndpoints() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://discord.com/api/oauth2/token") {
      return new Response(
        JSON.stringify({
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 604800,
          scope: "identify email guilds",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "https://discord.com/api/users/@me") {
      return new Response(
        JSON.stringify({ id: "disc-1", username: "tester", global_name: "Tester", avatar: null, email: "tester@example.com" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: `unexpected URL ${url}` }), { status: 500 });
  }) as unknown as typeof fetch;
}

// ──────────────────────────────────────────────
//  1. OAuth callback persistence
// ──────────────────────────────────────────────

describe("Discord OAuth callback persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.tokenRows = [];
    h.state.updates = [];
    h.state.insertCalls = [];
    process.env.DISCORD_CLIENT_ID = "client-1";
    process.env.DISCORD_CLIENT_SECRET = "secret-1";
    process.env.DISCORD_REDIRECT_URI = "http://localhost:3000/api/integrations/discord-callback";
    (h.queries.findUserByAuthId as Mock).mockResolvedValue({ id: "user-1" });
    (h.queries.getUserIntegrationByPlatform as Mock).mockResolvedValue({
      id: "int-1",
      userId: "user-1",
      platform: "discord",
      status: "not-connected",
    });
  });

  it("persists the full token set (access + refresh + expiry) and marks connected before redirecting", async () => {
    // A token row already exists → the reconnect/update path is exercised.
    h.state.tokenRows = [
      { id: "tok-1", integrationId: "int-1", accessToken: "old-at", refreshToken: "old-rt", expiresAt: null },
    ];
    mockDiscordEndpoints();

    const req = new Request(
      "http://localhost:3000/api/integrations/discord-callback?code=code-1&state=state-123&next=/dashboard/integrations/discord",
    );
    const res = await discordCallbackGET(req);

    // Redirect back to the app — success is only returned after persistence.
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard/integrations/discord");

    // The oauth_tokens upsert ran with the COMPLETE token set from Discord.
    const tokenUpdate = h.state.updates.find((u) => (u.data as Record<string, unknown>).accessToken === "at-1");
    expect(tokenUpdate).toBeDefined();
    expect((tokenUpdate!.data as Record<string, unknown>).refreshToken).toBe("rt-1");
    expect((tokenUpdate!.data as Record<string, unknown>).scope).toBe("identify email guilds");
    const expiresAt = (tokenUpdate!.data as Record<string, unknown>).expiresAt as Date;
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Status flipped to connected in the DB — not merely in frontend state.
    expect(h.queries.updateIntegrationStatus).toHaveBeenCalledWith("int-1", "connected");

    // Tokens never leak into the redirect target or any response surface.
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("at-1");
    expect(location).not.toContain("rt-1");
    // The redirect carries no body — nothing for tokens to leak into.
    expect(await res.text()).toBe("");
  });

  it("returns an error (no connected state) when the token exchange fails", async () => {
    h.state.tokenRows = [];
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "code already used" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const req = new Request(
      "http://localhost:3000/api/integrations/discord-callback?code=bad&state=state-123&next=/dashboard/integrations/discord",
    );
    const res = await discordCallbackGET(req);

    expect(res.status).toBe(500);
    // Nothing persisted, nothing marked connected.
    expect(h.state.updates.filter((u) => (u.data as Record<string, unknown>).accessToken !== undefined)).toHaveLength(0);
    expect(h.queries.updateIntegrationStatus).not.toHaveBeenCalledWith("int-1", "connected");
  });
});

// ──────────────────────────────────────────────
//  2 + 3. Status derived from the persisted DB row
// ──────────────────────────────────────────────

describe("Discord status is derived from the persisted DB row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.tokenRows = [];
  });

  it("reports connected after a refresh — the status comes from the DB row the callback persisted", async () => {
    (h.queries.getUserIntegrationByPlatform as Mock).mockResolvedValue({
      id: "int-1",
      userId: "user-1",
      platform: "discord",
      status: "connected",
      lastSyncAt: new Date(),
      metadata: null,
    });
    h.state.tokenRows = [
      { accessToken: "at", refreshToken: "rt", expiresAt: new Date(Date.now() + 7 * 86_400_000), updatedAt: new Date() },
    ];

    // A page refresh = a fresh read of the same DB row.
    const provider = new DiscordProvider();
    const first = await provider.status("user-1", "discord");
    const afterRefresh = await provider.status("user-1", "discord");

    expect(first.status).toBe("connected");
    expect(first.connected).toBe(true);
    expect(first.needsReconnect).toBe(false);
    expect(first.connectionHealth).toBe("healthy");
    expect(afterRefresh).toEqual(first);
  });

  it("does not flip an expired-access-but-refreshable session to not-connected", async () => {
    (h.queries.getUserIntegrationByPlatform as Mock).mockResolvedValue({
      id: "int-1",
      userId: "user-1",
      platform: "discord",
      status: "connected",
      lastSyncAt: new Date(),
      metadata: null,
    });
    // Access token expired, refresh token still valid → recoverable session.
    h.state.tokenRows = [
      { accessToken: "stale-at", refreshToken: "rt-valid", expiresAt: new Date(Date.now() - 1000), updatedAt: new Date() },
    ];

    const status = await new DiscordProvider().status("user-1", "discord");

    // Still connected — the token manager refreshes on demand; the status must
    // NOT be reset to not-connected merely because the access token expired.
    expect(status.status).toBe("connected");
    expect(status.connected).toBe(true);
    expect(status.tokenExpired).toBe(true);
    expect(status.needsReconnect).toBe(true);
  });

  it("reports not-connected when no integration row is persisted", async () => {
    (h.queries.getUserIntegrationByPlatform as Mock).mockResolvedValue(null);

    const status = await new DiscordProvider().status("user-1", "discord");

    expect(status.status).toBe("not-connected");
    expect(status.connected).toBe(false);
  });
});

// ──────────────────────────────────────────────
//  4. AI Discord tools work after a refresh
// ──────────────────────────────────────────────

describe("Discord AI tools work after a page refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.tokenRows = [];
    (h.queries.getCurrentUser as Mock).mockResolvedValue({ id: "auth-1" });
    (h.queries.findUserByAuthId as Mock).mockResolvedValue({ id: "user-1" });
    (h.queries.getUserIntegrationByPlatform as Mock).mockResolvedValue({
      id: "int-1",
      userId: "user-1",
      platform: "discord",
      status: "connected",
    });
    // Persisted, still-valid token — read fresh from the DB, like after a refresh.
    h.state.tokenRows = [
      { accessToken: "valid-at", refreshToken: "rt", expiresAt: new Date(Date.now() + 86_400_000) },
    ];
  });

  it("resolves the persisted integration and returns real messages via the real service", async () => {
    const getSpy = vi.spyOn(DiscordClient.prototype, "get").mockImplementation(async (path: string) => {
      if (path === "/users/@me/guilds") {
        return {
          data: [
            { id: "g1", name: "Acme", icon: null, owner: false, permissions: "1", approximate_member_count: 10, features: [], joined_at: "2026-01-01T00:00:00Z" },
          ],
          status: 200,
          headers: new Headers(),
          rateLimit: { limit: null, remaining: null, resetAt: null },
        };
      }
      if (path.startsWith("/guilds/g1/channels")) {
        return {
          data: [{ id: "c1", guild_id: "g1", name: "general", type: 0, position: 0, topic: null, parent_id: null, nsfw: false }],
          status: 200,
          headers: new Headers(),
          rateLimit: { limit: null, remaining: null, resetAt: null },
        };
      }
      if (path.startsWith("/channels/c1/messages")) {
        return {
          data: [
            {
              id: "m1",
              channel_id: "c1",
              author: { id: "a1", username: "alice" },
              content: "Ship the fix",
              timestamp: "2026-08-10T00:00:00Z",
              edited_timestamp: null,
              attachments: [],
              embeds: [],
              pinned: false,
              mentions: [],
            },
          ],
          status: 200,
          headers: new Headers(),
          rateLimit: { limit: null, remaining: null, resetAt: null },
        };
      }
      throw new Error(`unexpected Discord path: ${path}`);
    });

    try {
      // Real tool → real DiscordService → DiscordClient (spied transport).
      const tool = new DiscordRecentMessagesTool();
      const result = await tool.execute({ limit: 10 });

      expect(result.success).toBe(true);
      expect(result.tool).toBe("discord.recentMessages");
      expect(result.data).toMatchObject({ count: 1 });
      expect((result.data as { messages: Array<{ content: string; authorName: string }> }).messages[0]).toMatchObject({
        content: "Ship the fix",
        authorName: "alice",
      });
      expect(result.sources[0]).toMatchObject({ integration: "discord", type: "message" });
      // The integration was re-resolved from the persisted DB row, not from
      // any in-memory connection state.
      expect(h.queries.getUserIntegrationByPlatform).toHaveBeenCalledWith("user-1", "discord");
    } finally {
      getSpy.mockRestore();
    }
  });

  it("surfaces a clean reconnect error instead of fake data when the integration is gone", async () => {
    (h.queries.getUserIntegrationByPlatform as Mock).mockResolvedValue(null);

    const tool = new DiscordRecentMessagesTool();
    await expect(tool.execute({ limit: 10 })).rejects.toMatchObject({
      code: "discord_not_connected",
      status: 404,
    });
  });
});
