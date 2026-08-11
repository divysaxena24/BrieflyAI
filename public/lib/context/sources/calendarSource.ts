/**
 * Context Engine — Calendar context source.
 *
 * `CalendarSource` is the third real `ContextSource`: it retrieves relevant
 * calendar events from a calendar service and converts each event into a
 * `Context` object consumed by the pipeline.
 *
 * Note: the repository's existing calendar service
 * (`lib/services/calendar/calendarService.ts`) exposes a different surface
 * (`listEvents`, `getEvent`, `searchEvents`, ...) and does not yet provide
 * the `isAvailable(userId)` / `retrieveRelevantEvents(...)` contract this
 * source depends on. This module therefore defines the minimal structural
 * contract (`CalendarService` / `CalendarEvent`) in-file; a future adapter
 * or service extension satisfying that shape is required to wire this source
 * to the live API.
 */

import type { Context, ContextMetadata, RetrievalQuery } from "@/lib/context/types";
import { estimateTokens } from "@/lib/context/tokenBudget";
import { ContextSourceBase } from "./contextSource";

/** Source id used by `CalendarSource`. */
export const CALENDAR_SOURCE_ID = "calendar";

/** Default priority of `CalendarSource` relative to other sources. */
export const CALENDAR_SOURCE_PRIORITY = 60;

/** Default relevance used when an event carries no relevance score. */
export const DEFAULT_EVENT_RELEVANCE = 0.5;

/**
 * A single calendar event returned by a `CalendarService`.
 */
export interface CalendarEvent extends Record<string, unknown> {
  /** Stable provider-side id of the event. */
  id: string;
  /** Event title. */
  title: string;
  /** Event description text that will be sent to the LLM. */
  description: string;
  /** ISO start time of the event, or null/undefined when unknown. */
  startTime?: string | null;
  /** ISO end time of the event. Ignored by this phase of the pipeline. */
  endTime?: string | null;
  /** Relevance score in [0, 1]; 0.5 is assumed when missing. */
  relevance?: number;
  /** Human-readable organizer of the event, when known. */
  organizer?: string;
  /** Importance used during ranking. */
  importance?: ContextMetadata["importance"];
}

/**
 * Contract for the calendar service consumed by `CalendarSource`.
 *
 * The service decides how events are searched and ranked for relevance.
 * `CalendarSource` only depends on this surface.
 */
export interface CalendarService {
  /** Whether Calendar is available for the user right now. */
  isAvailable(userId: string): Promise<boolean>;
  /**
   * Return the events most relevant to a query, in relevance order
   * (best first). Implementations may use the query, conversation history,
   * and an item cap.
   */
  retrieveRelevantEvents(options: {
    userId: string;
    query: string;
    history?: string[];
    maxItems?: number;
  }): Promise<CalendarEvent[]>;
}

/**
 * Third real context source: retrieves relevant calendar events and maps them
 * to `Context` items.
 */
export class CalendarSource extends ContextSourceBase {
  private readonly calendarService: CalendarService;

  constructor(calendarService: CalendarService) {
    super(CALENDAR_SOURCE_ID, CALENDAR_SOURCE_PRIORITY);
    this.calendarService = calendarService;
  }

  /**
   * Whether Calendar is available for the user — delegated to the service.
   */
  async isAvailable(userId: string): Promise<boolean> {
    return this.calendarService.isAvailable(userId);
  }

  /**
   * Retrieve relevant events and map them to `Context` items.
   *
   * - The service is called with `userId`, `query`, `history`, and `maxItems`
   *   from the retrieval query (missing optional fields forwarded as
   *   `undefined`).
   * - Every returned event is mapped to a new `Context` with `source`
   *   `"calendar"`, `metadata.kind` `"event"`, `metadata.entityId` set to the
   *   event id, `metadata.author` set to the organizer, `metadata.importance`
   *   copied through, `metadata.raw` set to the original event object, and
   *   `permissions` `null`. `tokenEstimate` uses `estimateTokens(description)`;
   *   a missing `startTime` maps to `null` and a missing relevance to 0.5.
   *   `endTime` is intentionally ignored in this phase.
   * - Input order is preserved.
   * - A throwing service yields `[]` (never throws, no logging, no retries).
   * - Inputs are never mutated; each returned item is a new object.
   */
  async retrieve(query: RetrievalQuery): Promise<Context[]> {
    let events: CalendarEvent[];
    try {
      events = await this.calendarService.retrieveRelevantEvents({
        userId: query.userId,
        query: query.query,
        history: query.history,
        maxItems: query.maxItems,
      });
    } catch {
      return [];
    }
    return events.map((event) => this.toContext(event));
  }

  /** Map an event to a `Context` object (new object, no mutation). */
  private toContext(event: CalendarEvent): Context {
    return {
      id: event.id,
      source: CALENDAR_SOURCE_ID,
      title: event.title,
      content: event.description,
      timestamp: event.startTime ?? null,
      relevance: event.relevance ?? DEFAULT_EVENT_RELEVANCE,
      tokenEstimate: estimateTokens(event.description),
      truncated: false,
      compressed: false,
      metadata: {
        kind: "event",
        entityId: event.id,
        author: event.organizer,
        importance: event.importance,
        raw: event,
      },
      permissions: null,
    };
  }
}
