export type EventSummary = {
  id: string;
  calendarId?: string;
  summary: string | null;
  description?: string | null;
  location?: string | null;
  start: string | null; // ISO
  end: string | null; // ISO
  organizer?: { email?: string | null; displayName?: string | null } | null;
  attendees?: Array<{ email?: string; displayName?: string }>;
  status?: string | null;
};

export type EventDetail = EventSummary & {
  htmlLink?: string | null;
  recurrence?: string[] | null;
  // attachments metadata not implemented
};

export type CalendarListItem = {
  id: string;
  summary: string;
  timeZone?: string | null;
  accessRole?: string | null;
};

export type ListEventsResult = {
  events: EventSummary[];
  nextPageToken?: string | null;
};