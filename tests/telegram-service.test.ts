/**
 * TelegramService chat discovery regression tests.
 *
 * Root cause covered: Telegram bots can only see chats they have interacted
 * with (getUpdates). When the bot has received no updates, listChats returns an
 * empty list — this is a legitimate platform state, not an internal failure.
 * The service must (a) surface real chats when updates exist and (b) return an
 * empty list for a connected-but-idle bot (the AI layer converts it into a
 * clean 404 "no accessible chats" state).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppError } from "@/lib/errors";

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/db/queries", () => ({
  getUserIntegrationByPlatform: vi.fn(),
  findUserByAuthId: vi.fn(),
  logActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/services/integrations/telegramTokenManager", () => ({
  default: {
    getValidAccessToken: vi.fn(async () => ({ accessToken: "bot-token", expiresAt: null })),
    refreshToken: vi.fn(),
    invalidate: vi.fn(async () => true),
    isExpired: vi.fn(() => false),
    expiresSoon: vi.fn(() => false),
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { getCurrentUser } from "@/lib/auth";
import { getUserIntegrationByPlatform, findUserByAuthId } from "@/lib/db/queries";
import TelegramService from "@/lib/services/telegram/telegramService";
import { TelegramClient } from "@/lib/services/telegram/telegramClient";

describe("TelegramService chat discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getCurrentUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "auth-1" });
    (findUserByAuthId as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "user-1" });
    (getUserIntegrationByPlatform as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "int-1",
      userId: "user-1",
      platform: "telegram",
    });
  });

  it("returns an empty chat list when the bot has received no updates (idle bot)", async () => {
    // Telegram returns { ok: true, result: [] } for a bot nobody has contacted.
    vi.spyOn(TelegramClient.prototype, "get").mockResolvedValue({
      data: [],
      status: 200,
      headers: new Headers(),
    } as never);

    const result = await TelegramService.listChats();
    expect(result.chats).toEqual([]);
  });

  it("discovers real chats from message updates (groups, users, channels)", async () => {
    const updates = [
      { update_id: 1, message: { message_id: 10, date: 1750000000, chat: { id: 123, type: "group", title: "Dev Team" }, from: { id: 7, first_name: "Alice" }, text: "hi" } },
      { update_id: 2, channel_post: { message_id: 11, date: 1750000001, chat: { id: -100, type: "channel", title: "Announcements" }, text: "hello" } },
      { update_id: 3, message: { message_id: 12, date: 1750000002, chat: { id: 123, type: "group", title: "Dev Team" }, text: "again" } },
      { update_id: 4, edited_message: { message_id: 13, date: 1750000003, chat: { id: 456, type: "private", username: "bob" }, text: "edited" } },
    ];
    vi.spyOn(TelegramClient.prototype, "get").mockResolvedValue({
      data: updates,
      status: 200,
      headers: new Headers(),
    } as never);

    const result = await TelegramService.listChats();
    // Deduplicated by chat id — 3 unique chats.
    expect(result.chats.map((c) => c.id).sort()).toEqual([-100, 123, 456]);
    expect(result.chats.find((c) => c.id === 123)?.title).toBe("Dev Team");
  });

  it("maps a rejected getUpdates to an AppError (invalid bot token)", async () => {
    vi.spyOn(TelegramClient.prototype, "get").mockRejectedValue(
      new AppError("Unauthorized", 401, "authentication_required"),
    );
    await expect(TelegramService.listChats()).rejects.toMatchObject({
      code: "authentication_required",
      status: 401,
    });
  });

  it("listMessages returns only messages belonging to the requested chat", async () => {
    const updates = [
      { update_id: 1, message: { message_id: 10, date: 1750000000, chat: { id: 123, type: "group", title: "Dev Team" }, from: { id: 7, first_name: "Alice" }, text: "hello" } },
      { update_id: 2, message: { message_id: 11, date: 1750000001, chat: { id: 999, type: "group", title: "Other" }, from: { id: 8, first_name: "Bob" }, text: "other chat" } },
    ];
    vi.spyOn(TelegramClient.prototype, "get").mockResolvedValue({
      data: updates,
      status: 200,
      headers: new Headers(),
    } as never);

    const result = await TelegramService.listMessages("123");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ chatId: 123, text: "hello", senderName: "Alice" });
  });
});
