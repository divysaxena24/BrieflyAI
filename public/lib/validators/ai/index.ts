import { z } from "zod";

export const chatMessageSchema = z.object({
  message: z.string().min(1),
  context: z.any().optional(),
});

export type ChatMessageInput = z.infer<typeof chatMessageSchema>;
