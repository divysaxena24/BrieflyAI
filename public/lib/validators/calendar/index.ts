import { z } from "zod";

export const calendarEventQuery = z.object({
  calendarId: z.string().min(1).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const calendarEventIdSchema = z.string().min(1);
export const calendarPaginationSchema = z.object({
  maxResults: z.number().int().min(1).max(250).optional(),
  pageToken: z.string().optional(),
});

export const calendarSearchSchema = z.object({
  query: z.string().min(1),
  calendarId: z.string().min(1).optional(),
  maxResults: z.number().int().min(1).max(250).optional(),
});

export type CalendarEventQuery = z.infer<typeof calendarEventQuery>;

