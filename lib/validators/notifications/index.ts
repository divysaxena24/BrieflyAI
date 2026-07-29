import { z } from "zod";

export const createNotificationSchema = z.object({
  title: z.string().min(1),
  message: z.string().min(1),
  userId: z.string().uuid(),
  link: z.string().optional(),
});

export type CreateNotificationInput = z.infer<typeof createNotificationSchema>;
