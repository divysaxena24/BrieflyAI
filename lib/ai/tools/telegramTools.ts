/**
 * AI layer — Telegram tools.
 *
 * Three tools that reuse the existing production `TelegramService`:
 *
 * - `telegram.chatSummary`    → messages from a (resolved) chat
 * - `telegram.recentMessages` → recent real messages with a configurable limit
 * - `telegram.newsDigest`     → recent messages for digest-style summarization
 *
 * Chat resolution: when `chatId` is omitted, the tool uses the bot's first
 * known chat (from `listChats`) — real data, never invented. Nothing is
 * labeled \"news\" unless the actual chat content supports it: the digest
 * wording is produced by Groq strictly from the retrieved messages.
 */

import { z } from "zod";
import type { Tool } from "@/lib/tools/types";
import TelegramService from "@/lib/services/telegram/telegramService";
import type {
  ChatSummary,
  ListChatsResult,
  ListMessagesResult,
  MessageSummary,
} from "@/lib/services/telegram/telegramService";
import { AppError } from "@/lib/errors";
import { toolSuccess, truncate, type AIToolResult, type AIToolSource } from "./types";

/** Default / maximum messages read from a chat. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Cap for message text kept in normalized data. */
const TEXT_MAX = 400;

const chatInputSchema = z.object({
  /** Telegram chat id; defaults to the bot's first known chat. */
  chatId: z.string().min(1).optional(),
  /** Optional maximum number of messages (1-100). */
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

export type ChatToolInput = z.infer<typeof chatInputSchema>;

/**
 * Minimal structural surface of the production Telegram service used by the
 * tools (mirrors `lib/services/telegram/telegramService.ts`).
 */
export interface TelegramToolService {
  listChats(): Promise<ListChatsResult>;
  listMessages(chatId: string, limit?: number): Promise<ListMessagesResult>;
}

/** A resolved chat target. */
export interface ResolvedChat {
  chat: ChatSummary;
  title: string;
}

/** Resolve a chat from an explicit id or a real default. */
export async function resolveChat(
  service: TelegramToolService,
  chatId?: string,
): Promise<ResolvedChat> {
  if (chatId) {
    return { chat: { id: Number(chatId) || 0, title: chatId, username: null, type: "unknown" }, title: chatId };
  }
  const { chats } = await service.listChats();
  const first = chats[0];
  if (!first) {
    // A Telegram bot can only see chats it has interacted with — this is a
    // clean "no accessible chats" state, not an internal failure.
    throw new AppError(
      "No accessible Telegram chats found. Add your bot to a group or channel, or send it a message first — then try again.",
      404,
      "no_telegram_chats",
    );
  }
  return { chat: first, title: first.title };
}

/** Normalize a message for display + LLM context. */
export function toMessageSummary(message: MessageSummary) {
  return {
    id: message.id,
    senderName: message.senderName ?? "Unknown",
    text: truncate(message.text, TEXT_MAX),
    date: message.date ?? null,
  };
}

/** Source reference for a message. */
function messageSource(message: MessageSummary): AIToolSource {
  return {
    integration: "telegram",
    type: "message",
    id: String(message.id),
    title: message.senderName ?? undefined,
  };
}

async function fetchChatMessages(
  service: TelegramToolService,
  input: ChatToolInput,
): Promise<{ resolved: ResolvedChat; messages: MessageSummary[] }> {
  const resolved = await resolveChat(service, input.chatId);
  const { messages } = await service.listMessages(String(resolved.chat.id), input.limit ?? DEFAULT_LIMIT);
  return { resolved, messages };
}

/** Summarize the discussion in a Telegram chat. */
export class TelegramChatSummaryTool implements Tool {
  readonly id = "telegram.chatSummary";
  readonly description = "Fetch recent messages from a Telegram chat for discussion summarization.";
  readonly inputSchema = chatInputSchema;

  constructor(private readonly service: TelegramToolService = TelegramService) {}

  async execute(input: ChatToolInput): Promise<AIToolResult> {
    const { resolved, messages } = await fetchChatMessages(this.service, input);
    return toolSuccess(
      this.id,
      {
        chat: { id: resolved.chat.id, title: resolved.title, type: resolved.chat.type },
        count: messages.length,
        messages: messages.map(toMessageSummary),
      },
      messages.map(messageSource),
    );
  }
}

/** Return recent real messages from a Telegram chat. */
export class TelegramRecentMessagesTool implements Tool {
  readonly id = "telegram.recentMessages";
  readonly description = "List recent messages from a Telegram chat.";
  readonly inputSchema = chatInputSchema;

  constructor(private readonly service: TelegramToolService = TelegramService) {}

  async execute(input: ChatToolInput): Promise<AIToolResult> {
    const { resolved, messages } = await fetchChatMessages(this.service, input);
    return toolSuccess(
      this.id,
      {
        chat: { id: resolved.chat.id, title: resolved.title, type: resolved.chat.type },
        count: messages.length,
        messages: messages.map(toMessageSummary),
      },
      messages.map(messageSource),
    );
  }
}

/** Fetch recent Telegram messages for digest-style summarization. */
export class TelegramNewsDigestTool implements Tool {
  readonly id = "telegram.newsDigest";
  readonly description = "Fetch recent Telegram chat messages to build a digest from.";
  readonly inputSchema = chatInputSchema;

  constructor(private readonly service: TelegramToolService = TelegramService) {}

  async execute(input: ChatToolInput): Promise<AIToolResult> {
    const { resolved, messages } = await fetchChatMessages(this.service, input);
    return toolSuccess(
      this.id,
      {
        chat: { id: resolved.chat.id, title: resolved.title, type: resolved.chat.type },
        count: messages.length,
        messages: messages.map(toMessageSummary),
      },
      messages.map(messageSource),
    );
  }
}
