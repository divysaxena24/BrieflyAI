/**
 * Context Engine — Calendar service adapter.
 *
 * Bridges the repository's production calendar service
 * (`lib/services/calendar/calendarService.ts`) to the `CalendarService`
 * contract consumed by `CalendarSource`.
 *
 * The production service is a request-scoped static API: it derives the
 * current user from the request context and exposes `createClientForUser`,
 * `listEvents`, and `searchEvents` (returning `EventSummary[]`). The contract
 * surface differs, so this adapter performs pure delegation plus field
 * mapping:
 *
 * - `isAvailable` probes the production service's client creation; any
 *   failure (unauthenticated, integration not connected, invalid token)
 *   means Calendar is unavailable for the user.
 * - `retrieveRelevantEvents` delegates to `searchEvents` when a query is
 *   provided and to `listEvents` otherwise, then maps each production
 *   `EventSummary` into the `CalendarEvent` contract shape — ordering
 *   preserved, no filtering, no reranking, no deduplication, no truncation.
 *
 * Service failures are forwarded, never swallowed; `CalendarSource` already
 * converts retrieval failures into an empty result. Because the production
 * service is request-scoped, the `userId` accepted by the contract is not
 * forwarded to it.
 *
 * Note on `searchEvents`: the production signature is
 * `searchEvents(q, calendarId?, maxResults?, pageToken?)`. The adapter
 * therefore passes `undefined` for `calendarId` so that `maxItems` lands in
 * the `maxResults` position (`searchEvents(query, undefined, maxItems)`).
 */

import CalendarService from "@/lib/services/calendar";
import type { EventSummary, ListEventsResult } from "@/lib/services/calendar/types";
import type {
  CalendarEvent,
  CalendarService as CalendarServiceContract,
} from "@/lib/context/sources/calendarSource";

/**
 * Minimal structural surface of the production calendar service that the
 * adapter depends on. Mirrors the static members of
 * `lib/services/calendar/calendarService.ts`.
 */
export interface ProductionCalendarService {
  /** Resolve the current user's calendar client and integration (throws when unavailable). */
  createClientForUser(): Promise<unknown>;
  /** List upcoming events for the current user. */
  listEvents(params?: {
    calendarId?: string;
    from?: string;
    to?: string;
    maxResults?: number;
    pageToken?: string;
  }): Promise<ListEventsResult>;
  /** Search events for the current user. */
  searchEvents(q: string, calendarId?: string, maxResults?: number, pageToken?: string): Promise<ListEventsResult>;
}

/**
 * Pure adapter exposing the `CalendarSource`-required `CalendarService`
 * contract over the production calendar service.
 */
export class CalendarServiceAdapter implements CalendarServiceContract {
  private readonly service: ProductionCalendarService;

  constructor(service: ProductionCalendarService = CalendarService) {
    this.service = service;
  }

  /**
   * Whether Calendar is available for the user.
   *
   * Delegates to the production service by attempting to create a client for
   * the current user. Any failure (unauthenticated, integration not
   * connected, invalid token) means Calendar is unavailable. No caching, no
   * retries, no logging.
   *
   * The production service resolves the user from the request context, so
   * the contract's `userId` is not forwarded to it.
   */
  async isAvailable(userId: string): Promise<boolean> {
    // The production service resolves the user from the request context, so
    // the contract's `userId` is not forwarded to it.
    void userId;
    try {
      await this.service.createClientForUser();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retrieve the events most relevant to a query.
   *
   * A non-empty query is delegated to
   * `searchEvents(query, undefined, maxItems)` (query passed verbatim;
   * `calendarId` left undefined so `maxItems` fills the `maxResults`
   * parameter); an empty/blank query lists upcoming events via
   * `listEvents({ maxResults: maxItems })`. The production response is mapped
   * field-by-field into `CalendarEvent` objects, preserving order. No
   * filtering, no reranking, no deduplication, no truncation.
   *
   * Service failures are forwarded (never swallowed); `CalendarSource`
   * handles them by returning `[]`.
   */
  async retrieveRelevantEvents(options: {
    userId: string;
    query: string;
    history?: string[];
    maxItems?: number;
  }): Promise<CalendarEvent[]> {
    const { query, maxItems } = options;
    const result =
      query.trim().length > 0
        ? await this.service.searchEvents(query, undefined, maxItems)
        : await this.service.listEvents({ maxResults: maxItems });
    return result.events.map((event) => this.toEvent(event));
  }

  /**
   * Map a production `EventSummary` to the `CalendarEvent` contract.
   *
   * - `title` maps to the production `summary`; required `title`/`description`
   *   normalize a `null` production value to an empty string (the neutral
   *   "no value" representation).
   * - `startTime`/`endTime` map to the production `start`/`end`; a missing
   *   timestamp maps to `undefined`.
   * - `organizer` maps to the production organizer's `displayName`, falling
   *   back to its `email`; a missing organizer maps to `undefined`.
   * - `relevance` and `importance` are not produced by the service and are
   *   intentionally omitted (never invented); `CalendarSource` defaults
   *   relevance to 0.5.
   */
  private toEvent(event: EventSummary): CalendarEvent {
    return {
      id: event.id,
      title: event.summary ?? "",
      description: event.description ?? "",
      startTime: event.start ?? undefined,
      endTime: event.end ?? undefined,
      organizer: this.organizerToString(event.organizer),
    };
  }

  /** Reduce a production organizer object to a single display string. */
  private organizerToString(organizer: EventSummary["organizer"]): string | undefined {
    if (!organizer) return undefined;
    return organizer.displayName ?? organizer.email ?? undefined;
  }
}
