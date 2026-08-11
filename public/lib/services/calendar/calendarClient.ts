import { safeFetch } from "@/lib/services/google-http";

const BASE = "https://www.googleapis.com/calendar/v3";

export class CalendarClient {
  accessToken: string;
  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private headers() {
    return { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" } as Record<string, string>;
  }

  async listEvents(params: { calendarId?: string; timeMin?: string; timeMax?: string; q?: string; maxResults?: number; pageToken?: string }) {
    const cal = params.calendarId ?? "primary";
    const url = new URL(`${BASE}/calendars/${encodeURIComponent(cal)}/events`);
    if (params.timeMin) url.searchParams.set("timeMin", params.timeMin);
    if (params.timeMax) url.searchParams.set("timeMax", params.timeMax);
    if (params.q) url.searchParams.set("q", params.q);
    if (params.maxResults) url.searchParams.set("maxResults", String(params.maxResults));
    if (params.pageToken) url.searchParams.set("pageToken", params.pageToken);
    // request minimal fields
    url.searchParams.set("fields", "items(id,summary,description,location,start,end,organizer,attendees,status,htmlLink),nextPageToken");

    const res = await safeFetch(url.toString(), { method: "GET", headers: this.headers() }, { url: url.pathname });
    if (!res.ok) throw res;
    return res.json();
  }

  async getEvent(eventId: string, calendarId?: string) {
    const cal = calendarId ?? "primary";
    const url = new URL(`${BASE}/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eventId)}`);
    url.searchParams.set("fields", "id,summary,description,location,start,end,organizer,attendees,status,htmlLink,recurrence");
    const res = await safeFetch(url.toString(), { method: "GET", headers: this.headers() }, { url: url.pathname, eventId, calendarId: cal });
    if (!res.ok) throw res;
    return res.json();
  }

  async listCalendars() {
    const url = new URL(`${BASE}/users/me/calendarList`);
    url.searchParams.set("fields", "items(id,summary,timeZone,accessRole)");
    const res = await safeFetch(url.toString(), { method: "GET", headers: this.headers() }, { url: url.pathname });
    if (!res.ok) throw res;
    return res.json();
  }
}
