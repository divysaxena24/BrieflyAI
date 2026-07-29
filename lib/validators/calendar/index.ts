import { z } from "zod";

export const calendarEventQuery = z.object({
  calendarId: z.string().min(1).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export type CalendarEventQuery = z.infer<typeof calendarEventQuery>;
