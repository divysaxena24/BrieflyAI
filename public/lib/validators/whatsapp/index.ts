import { z } from "zod";

// Query params for GET /api/whatsapp/messages
// chatId is required (the WhatsApp jid, e.g. "15551234567@s.whatsapp.net");
// limit is optional (1–100)
export const whatsappMessagesSchema = z.object({
  chatId: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
});

// Query params for GET /api/whatsapp/search
// query is required; limit is optional (1–100)
export const whatsappSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
});

export type WhatsAppMessagesQuery = z.infer<typeof whatsappMessagesSchema>;
export type WhatsAppSearchQuery = z.infer<typeof whatsappSearchSchema>;
