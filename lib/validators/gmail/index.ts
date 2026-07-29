import { z } from "zod";

export const gmailSearchSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(100).optional(),
});

export const gmailIdSchema = z.string().min(1);
export const gmailThreadIdSchema = z.string().min(1);
export const gmailPaginationSchema = z.object({
  maxResults: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
});

export const gmailLabelIdSchema = z.string().min(1);

export type GmailSearchInput = z.infer<typeof gmailSearchSchema>;
