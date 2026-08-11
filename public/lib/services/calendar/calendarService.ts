import { getCurrentUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { glogger } from "@/lib/services/google-logger";
import { getUserIntegrationByPlatform, findUserByAuthId, logActivity } from "@/lib/db/queries";
import tokenManager from "@/lib/services/integrations/googleTokenManager";
import { CalendarClient } from "./calendarClient";
import { mapStatusToAppError } from "@/lib/services/google-errors";
import type { EventSummary, EventDetail, ListEventsResult, CalendarListItem } from "./types";

const PLATFORM = "gmail"; // matches the platform stored by OAuth callback

export class CalendarService {
  static async createClientForUser() {
    const user = await getCurrentUser();
    if (!user) throw new AppError("Not authenticated", 401, "authentication_required");

    // Resolve the application user ID — getCurrentUser() returns auth.users.id,
    // but integrations.user_id references users.id (the application-level ID)
    const appUser = await findUserByAuthId(user.id);
    if (!appUser) throw new AppError("User not found", 404, "user_not_found");

    const integration = await getUserIntegrationByPlatform(appUser.id, PLATFORM);
    if (!integration) throw new AppError("No Google integration found for user", 404, "google_not_connected");

    const token = await tokenManager.getValidAccessToken(integration.id);
    if (!token || !token.accessToken) throw new AppError("Authentication required", 401, "authentication_required");

    return { client: new CalendarClient(token.accessToken), integration };
  }

  static async listEvents(params: { calendarId?: string; from?: string; to?: string; maxResults?: number; pageToken?: string } = {}): Promise<ListEventsResult> {
    glogger.info("CalendarService: listEvents request received", { params });
    const { client, integration } = await CalendarService.createClientForUser();
    try {
      const res = await client.listEvents({ calendarId: params.calendarId, timeMin: params.from, timeMax: params.to, maxResults: params.maxResults, pageToken: params.pageToken });
      const items = res.items ?? [];
      const nextPageToken = res.nextPageToken ?? null;
      const events: EventSummary[] = items.map((i: any) => ({
        id: i.id,
        calendarId: params.calendarId ?? "primary",
        summary: i.summary ?? null,
        description: i.description ?? null,
        location: i.location ?? null,
        start: i.start?.dateTime ?? i.start?.date ?? null,
        end: i.end?.dateTime ?? i.end?.date ?? null,
        organizer: i.organizer ? { email: i.organizer.email ?? null, displayName: i.organizer.displayName ?? null } : null,
        attendees: (i.attendees ?? []).map((a: any) => ({ email: a.email ?? undefined, displayName: a.displayName ?? undefined })),
        status: i.status ?? null,
      }));

      glogger.info("CalendarService: events returned", { count: events.length });
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Viewed Events",
        details: `Listed ${events.length} events`,
        integrationId: integration.id,
      }).catch((e) => glogger.debug("logActivity failed", { error: String(e) }));
      return { events, nextPageToken };
    } catch (err: any) {
      glogger.error("CalendarService: listEvents failed", { error: String(err) });
      if (err instanceof AppError) throw err;
      const status = err?.status ?? err?.statusCode ?? null;
      // Try to extract the real Google API error from the response body before it is lost
      let body: any = undefined;
      try { if (typeof err?.json === "function") body = await err.json(); } catch {}
      if (status === 401 ) { try { await tokenManager.invalidate(integration.id); } catch {} }
      throw mapStatusToAppError(status, body);
    }
  }

  static async getEvent(eventId: string, calendarId?: string): Promise<EventDetail> {
    glogger.info("CalendarService: getEvent request received", { eventId, calendarId });
    const { client, integration } = await CalendarService.createClientForUser();
    try {
      const res = await client.getEvent(eventId, calendarId);
      const detail: EventDetail = {
        id: res.id,
        calendarId: calendarId ?? "primary",
        summary: res.summary ?? null,
        description: res.description ?? null,
        location: res.location ?? null,
        start: res.start?.dateTime ?? res.start?.date ?? null,
        end: res.end?.dateTime ?? res.end?.date ?? null,
        organizer: res.organizer ? { email: res.organizer.email ?? null, displayName: res.organizer.displayName ?? null } : null,
        attendees: (res.attendees ?? []).map((a: any) => ({ email: a.email ?? undefined, displayName: a.displayName ?? undefined })),
        status: res.status ?? null,
        htmlLink: res.htmlLink ?? null,
        recurrence: res.recurrence ?? null,
      };
      glogger.info("CalendarService: event returned", { eventId });
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Viewed Event",
        details: `Viewed event ${eventId}`,
        integrationId: integration.id,
      }).catch((e) => glogger.debug("logActivity failed", { error: String(e) }));
      return detail;
    } catch (err: any) {
      glogger.error("CalendarService: getEvent failed", { eventId, error: String(err) });
      if (err instanceof AppError) throw err;
      const status = err?.status ?? err?.statusCode ?? null;
      // Try to extract the real Google API error from the response body before it is lost
      let body: any = undefined;
      try { if (typeof err?.json === "function") body = await err.json(); } catch {}
      if (status === 404) throw new AppError("Event not found", 404, "not_found");
      if (status === 401 ) { try { await tokenManager.invalidate(integration.id); } catch {} }
      throw mapStatusToAppError(status, body);
    }
  }

  static async listCalendars(): Promise<CalendarListItem[]> {
    glogger.info("CalendarService: listCalendars request received");
    const { client, integration } = await CalendarService.createClientForUser();
    try {
      const res = await client.listCalendars();
      const items = res.items ?? [];
      const calendars: CalendarListItem[] = items.map((c: any) => ({ id: c.id, summary: c.summary, timeZone: c.timeZone ?? null, accessRole: c.accessRole ?? null }));
      glogger.info("CalendarService: calendars returned", { count: calendars.length });
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Listed Calendars",
        details: `Listed ${calendars.length} calendars`,
        integrationId: integration.id,
      }).catch((e) => glogger.debug("logActivity failed", { error: String(e) }));
      return calendars;
    } catch (err: any) {
      glogger.error("CalendarService: listCalendars failed", { error: String(err) });
      if (err instanceof AppError) throw err;
      const status = err?.status ?? err?.statusCode ?? null;
      // Try to extract the real Google API error from the response body before it is lost
      let body: any = undefined;
      try { if (typeof err?.json === "function") body = await err.json(); } catch {}
      if (status === 401 ) { try { await tokenManager.invalidate(integration.id); } catch {} }
      throw mapStatusToAppError(status, body);
    }
  }

  static async searchEvents(q: string, calendarId?: string, maxResults?: number, pageToken?: string) {
    glogger.info("CalendarService: searchEvents request received", { q, calendarId });
    const { client, integration } = await CalendarService.createClientForUser();
    try {
      const res = await client.listEvents({ calendarId, q, maxResults, pageToken });
      const items = res.items ?? [];
      const nextPageToken = res.nextPageToken ?? null;
      const events: EventSummary[] = items.map((i: any) => ({
        id: i.id,
        calendarId: calendarId ?? "primary",
        summary: i.summary ?? null,
        description: i.description ?? null,
        location: i.location ?? null,
        start: i.start?.dateTime ?? i.start?.date ?? null,
        end: i.end?.dateTime ?? i.end?.date ?? null,
        organizer: i.organizer ? { email: i.organizer.email ?? null, displayName: i.organizer.displayName ?? null } : null,
        attendees: (i.attendees ?? []).map((a: any) => ({ email: a.email ?? undefined, displayName: a.displayName ?? undefined })),
        status: i.status ?? null,
      }));
      glogger.info("CalendarService: search completed", { count: events.length });
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Searched Events",
        details: `Searched for "${q}"`,
        integrationId: integration.id,
      }).catch((e) => glogger.debug("logActivity failed", { error: String(e) }));
      return { events, nextPageToken };
    } catch (err: any) {
      glogger.error("CalendarService: searchEvents failed", { error: String(err) });
      if (err instanceof AppError) throw err;
      const status = err?.status ?? err?.statusCode ?? null;
      // Try to extract the real Google API error from the response body before it is lost
      let body: any = undefined;
      try { if (typeof err?.json === "function") body = await err.json(); } catch {}
      if (status === 401 ) { try { await tokenManager.invalidate(integration.id); } catch {} }
      throw mapStatusToAppError(status, body);
    }
  }
}

export default CalendarService;
