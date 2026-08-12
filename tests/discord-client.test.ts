/**
 * DiscordClient + DiscordService regression tests.
 *
 * Root causes covered:
 * - Discord returned "401: Unauthorized" because the stored access token was
 *   stale/expired and nothing refreshed it. The client must refresh once and
 *   retry the request before surfacing an error.
 * - The service previously wiped the token row on 401 (invalidate), which is
 *   what produced the follow-up "Refresh token missing" failure. It must mark
 *   needs_reconnect instead.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppError } from "@/lib/errors";

// The token manager is fully mocked for the client/service tests.
vi.mock("@/lib/services/integrations/discordTokenManager", () => ({
  default: {
    getValidAccessToken: vi.fn(async () => ({ accessToken: "stale-token" })),
    refreshToken: vi.fn(async () => ({ access_token: "fresh-token", expiresAt: new Date(Date.now() + 3600_000) })),
    invalidate: vi.fn(async () => true),
  },
}));

vi.mock("@/lib/services/google-http", () => ({
  safeFetch: vi.fn(),
}));

vi.mock("@/lib/services/discord/discordUtils", () => ({
  buildQueryString: (params: Record<string, string | number | null | undefined>) =>
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join("&"),
  parseRateLimit: () => ({ limit: null, remaining: null, resetAt: null }),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn() }));

vi.mock("@/lib/db/queries", () => ({
  getUserIntegrationByPlatform: vi.fn(),
  findUserByAuthId: vi.fn(),
  logActivity: vi.fn().mockResolvedValue(undefined),
  updateIntegrationStatus: vi.fn(async () => undefined),
}));

import discordTokenManager from "@/lib/services/integrations/discordTokenManager";
import { safeFetch } from "@/lib/services/google-http";
import { getCurrentUser } from "@/lib/auth";
import { getUserIntegrationByPlatform, findUserByAuthId, updateIntegrationStatus } from "@/lib/db/queries";
import { DiscordClient } from "@/lib/services/discord/discordClient";
import DiscordService from "@/lib/services/discord/discordService";

function httpResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "Content-Type": "application/json" }),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("DiscordClient 401 recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (discordTokenManager.getValidAccessToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      accessToken: "stale-token",
    });
    (discordTokenManager.refreshToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      access_token: "fresh-token",
      expiresAt: new Date(Date.now() + 3600_000),
    });
  });

  it("refreshes once and retries when Discord rejects the stored token with 401", async () => {
    const fetchMock = safeFetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(httpResponse(401, { message: "401: Unauthorized" }))
      .mockResolvedValueOnce(httpResponse(200, [{ id: "g1", name: "Acme" }]));

    const client = new DiscordClient("int-1");
    const res = await client.get<Array<{ id: string; name: string }>>("/users/@me/guilds");

    expect(discordTokenManager.refreshToken).toHaveBeenCalledWith("int-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh-token");
    expect(res.data).toEqual([{ id: "g1", name: "Acme" }]);
  });

  it("rethrows the clean reconnect error when the refresh itself fails", async () => {
    (discordTokenManager.refreshToken as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new AppError("Discord needs to be reconnected — your Discord session expired", 401, "reconnect_required"),
    );

    const fetchMock = safeFetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(httpResponse(401, { message: "401: Unauthorized" }));

    const client = new DiscordClient("int-1");
    await expect(client.get("/users/@me/guilds")).rejects.toMatchObject({
      code: "reconnect_required",
      status: 401,
    });
    // Only one HTTP attempt — no retry with a stale token.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the auth error when the retried request is still rejected (no infinite loop)", async () => {
    const fetchMock = safeFetch as unknown as ReturnType<typeof vi.fn>;
    // Original request 401s, refresh succeeds, retry 401s again — the client
    // must NOT refresh a second time or retry again.
    fetchMock
      .mockResolvedValueOnce(httpResponse(401, { message: "401: Unauthorized" }))
      .mockResolvedValueOnce(httpResponse(401, { message: "401: Unauthorized" }));

    const client = new DiscordClient("int-1");
    await expect(client.get("/users/@me/guilds")).rejects.toMatchObject({
      code: "authentication_required",
      status: 401,
    });
    // Exactly one refresh and exactly one retry — no loop, no recursion.
    expect(discordTokenManager.refreshToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps non-401 failures as-is without refreshing", async () => {
    const fetchMock = safeFetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(httpResponse(404, { message: "Unknown Guild" }));

    const client = new DiscordClient("int-1");
    await expect(client.get("/guilds/missing")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(discordTokenManager.refreshToken).not.toHaveBeenCalled();
  });
});

describe("DiscordService 401 handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getCurrentUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "auth-1" });
    (findUserByAuthId as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "user-1" });
    (getUserIntegrationByPlatform as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "int-1",
      userId: "user-1",
      platform: "discord",
    });
  });

  it("marks needs_reconnect on a 401 AppError instead of wiping the token row", async () => {
    vi.spyOn(DiscordClient.prototype, "get").mockRejectedValue(
      new AppError("Discord needs to be reconnected — your Discord session expired", 401, "reconnect_required"),
    );

    await expect(DiscordService.listGuilds()).rejects.toMatchObject({ code: "reconnect_required" });
    expect(updateIntegrationStatus).toHaveBeenCalledWith("int-1", "needs_reconnect");
    // The token manager must NOT be invalidated (that wipes the refresh token).
    expect(discordTokenManager.invalidate).not.toHaveBeenCalled();
  });

  it("propagates non-401 AppErrors without touching the integration status", async () => {
    vi.spyOn(DiscordClient.prototype, "get").mockRejectedValue(new AppError("Unknown Guild", 404, "not_found"));

    await expect(DiscordService.listGuilds()).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(updateIntegrationStatus).not.toHaveBeenCalled();
    expect(discordTokenManager.invalidate).not.toHaveBeenCalled();
  });
});
