/**
 * AI layer — Google Calendar tools.
 *
 * Four tools that reuse the existing production `CalendarService`:
 *
 * - `calendar.todaySchedule`    → today's real events, chronologically ordered
 * - `calendar.upcomingMeetings` → upcoming events within a configurable window
 * - `calendar.meetingPreparation` → a real event's details (optionally the
 *   next upcoming meeting) for meeting prep
 * - `calendar.scheduleSummary`  → events over a configurable window
 *
 * Tools never invent meeting information — they only return what the
 * Calendar API actually returned.
 */

import { z } from "zod";
import type { Tool } from "@/lib/tools/types";
import CalendarService from "@/lib/services/calendar";
import type {
  EventDetail,
  EventSummary,
  ListEventsResult,
} from "@/lib/services/calendar/types";
import { AppError } from "@/lib/errors";
import { toolSuccess, truncate, type AIToolResult, type AIToolSource } from "./types";

/** Default maximum events a tool fetches. */
const MAX_EVENTS = 50;

/** Cap for event descriptions kept in normalized data. */
const DESCRIPTION_MAX = 300;

const maxResultsSchema = z.number().int().min(1).max(MAX_EVENTS).optional();

/** Input schema for `calendar.todaySchedule`. */
const todayInputSchema = z.object({
  maxResults: maxResultsSchema,
});

/** Input schema for `calendar.upcomingMeetings`. */
const upcomingInputSchema = z.object({
  /** Number of days ahead to include (1-30, default 7). */
  days: z.number().int().min(1).max(30).optional(),
  maxResults: maxResultsSchema,
});

/** Input schema for `calendar.meetingPreparation`. */
const preparationInputSchema = z.object({
  /** Event id to prepare for; defaults to the next upcoming event. */
  eventId: z.string().min(1).optional(),
});

/** Input schema for `calendar.scheduleSummary`. */
const scheduleSummaryInputSchema = z.object({
  /** Number of days ahead to summarize (1-30, default 7). */
  days: z.number().int().min(1).max(30).optional(),
});

export type TodayScheduleInput = z.infer<typeof todayInputSchema>;
export type UpcomingMeetingsInput = z.infer<typeof upcomingInputSchema>;
export type MeetingPreparationInput = z.infer<typeof preparationInputSchema>;
export type ScheduleSummaryInput = z.infer<typeof scheduleSummaryInputSchema>;

/**
 * Minimal structural surface of the production Calendar service used by the
 * tools (mirrors `lib/services/calendar/calendarService.ts`).
 */
export interface CalendarToolService {
  listEvents(params?: {
    calendarId?: string;
    from?: string;
    to?: string;
    maxResults?: number;
    pageToken?: string;
  }): Promise<ListEventsResult>;
  getEvent(eventId: string, calendarId?: string): Promise<EventDetail>;
}

/** Normalize an event for display + LLM context (no invented data). */
export function toEventSummary(event: EventSummary) {
  return {
    id: event.id,
    summary: event.summary ?? "",
    description: truncate(event.description ?? "", DESCRIPTION_MAX),
    location: event.location ?? null,
    start: event.start ?? null,
    end: event.end ?? null,
    organizer: event.organizer?.displayName ?? event.organizer?.email ?? null,
    attendees: (event.attendees ?? []).map((attendee) => ({
      email: attendee.email ?? "",
      displayName: attendee.displayName ?? "",
    })),
    status: event.status ?? null,
  };
}

/** Source reference for an event. */
function eventSource(event: EventSummary | EventDetail): AIToolSource {
  return {
    integration: "calendar",
    type: "event",
    id: event.id,
    title: event.summary ?? undefined,
    url: "htmlLink" in event && event.htmlLink ? event.htmlLink : undefined,
  };
}

/** Sort events chronologically by start time (missing starts last). */
export function sortByStart<T extends { start?: string | null }>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
}

/** Start of the current day in the server's local timezone. */
export function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

/** End of the current day in the server's local timezone. */
export function endOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
}

/** `now + days` instant. */
export function daysFromNow(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Summarize the user's schedule for today. */
export class CalendarTodayScheduleTool implements Tool {
  readonly id = "calendar.todaySchedule";
  readonly description = "Fetch the user's calendar events scheduled for today.";
  readonly inputSchema = todayInputSchema;

  constructor(
    private readonly service: CalendarToolService = CalendarService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: TodayScheduleInput): Promise<AIToolResult> {
    const current = this.now();
    const from = startOfDay(current);
    const to = endOfDay(current);
    const result = await this.service.listEvents({
      from: from.toISOString(),
      to: to.toISOString(),
      maxResults: input.maxResults ?? MAX_EVENTS,
    });
    const events = sortByStart(result.events);
    return toolSuccess(
      this.id,
      {
        date: from.toISOString().slice(0, 10),
        count: events.length,
        events: events.map(toEventSummary),
      },
      events.map(eventSource),
    );
  }
}

/** List the user's upcoming meetings within a configurable window. */
export class CalendarUpcomingMeetingsTool implements Tool {
  readonly id = "calendar.upcomingMeetings";
  readonly description = "List the user's upcoming calendar meetings within a time window.";
  readonly inputSchema = upcomingInputSchema;

  constructor(
    private readonly service: CalendarToolService = CalendarService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: UpcomingMeetingsInput): Promise<AIToolResult> {
    const current = this.now();
    const days = input.days ?? 7;
    const from = current;
    const to = daysFromNow(current, days);
    const result = await this.service.listEvents({
      from: from.toISOString(),
      to: to.toISOString(),
      maxResults: input.maxResults ?? 20,
    });
    const events = sortByStart(result.events);
    return toolSuccess(
      this.id,
      {
        window: { from: from.toISOString(), to: to.toISOString(), days },
        count: events.length,
        events: events.map(toEventSummary),
      },
      events.map(eventSource),
    );
  }
}

/** Prepare for a specific (or next) meeting using real event details. */
export class CalendarMeetingPreparationTool implements Tool {
  readonly id = "calendar.meetingPreparation";
  readonly description = "Fetch a calendar event's details to prepare for a meeting.";
  readonly inputSchema = preparationInputSchema;

  constructor(
    private readonly service: CalendarToolService = CalendarService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: MeetingPreparationInput): Promise<AIToolResult> {
    let event: EventDetail;
    if (input.eventId) {
      event = await this.service.getEvent(input.eventId);
    } else {
      // Resolve the next upcoming event from real data (never invented).
      const result = await this.service.listEvents({
        from: this.now().toISOString(),
        maxResults: 1,
      });
      const next = result.events[0];
      if (!next) {
        throw new AppError("No upcoming meetings found", 404, "no_upcoming_events");
      }
      event = await this.service.getEvent(next.id);
    }
    return toolSuccess(
      this.id,
      {
        event: {
          ...toEventSummary(event),
          htmlLink: "htmlLink" in event ? event.htmlLink : null,
          recurrence: "recurrence" in event ? event.recurrence : null,
        },
      },
      [eventSource(event)],
    );
  }
}

/** Summarize the user's schedule over a configurable window. */
export class CalendarScheduleSummaryTool implements Tool {
  readonly id = "calendar.scheduleSummary";
  readonly description = "Fetch the user's calendar events over a time window for summarization.";
  readonly inputSchema = scheduleSummaryInputSchema;

  constructor(
    private readonly service: CalendarToolService = CalendarService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: ScheduleSummaryInput): Promise<AIToolResult> {
    const current = this.now();
    const days = input.days ?? 7;
    const from = current;
    const to = daysFromNow(current, days);
    const result = await this.service.listEvents({
      from: from.toISOString(),
      to: to.toISOString(),
      maxResults: MAX_EVENTS,
    });
    const events = sortByStart(result.events);
    return toolSuccess(
      this.id,
      {
        window: { from: from.toISOString(), to: to.toISOString(), days },
        count: events.length,
        events: events.map(toEventSummary),
      },
      events.map(eventSource),
    );
  }
}
