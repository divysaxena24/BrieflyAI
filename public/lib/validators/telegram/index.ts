import { z } from "zod";

// Request body for POST /api/integrations/telegram-connect
// token is required and must be a non-empty string
export const telegramConnectSchema = z.object({
  token: z.string().min(1),
});

// Query params for GET /api/telegram/bot
// No required params today — kept for API contract consistency
export const telegramBotSchema = z.object({});

// Query params for GET /api/telegram/chat
// chatId is required (numeric id, @username, or t.me URL)
export const telegramChatSchema = z.object({
  chatId: z.string().min(1),
});

// Query params for GET /api/telegram/messages
// chatId is required; limit is optional (1–100)
export const telegramMessagesSchema = z.object({
  chatId: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
});

// Query params for GET /api/telegram/search
// query is required; chatIds/limit are optional
export const telegramSearchSchema = z.object({
  query: z.string().min(1),
  chatIds: z.array(z.string().min(1)).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export type TelegramConnectPayload = z.infer<typeof telegramConnectSchema>;
export type TelegramBotQuery = z.infer<typeof telegramBotSchema>;
export type TelegramChatQuery = z.infer<typeof telegramChatSchema>;
export type TelegramMessagesQuery = z.infer<typeof telegramMessagesSchema>;
export type TelegramSearchQuery = z.infer<typeof telegramSearchSchema>;
