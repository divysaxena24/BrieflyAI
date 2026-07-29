import { z } from "zod";

export const connectIntegrationSchema = z.object({
  platformId: z.string().min(1),
  redirectUri: z.string().url().optional(),
});

export const integrationQuerySchema = z.object({
  platformId: z.string().optional(),
});

export type ConnectIntegrationInput = z.infer<typeof connectIntegrationSchema>;
