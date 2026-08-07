import { describe, it, expect, vi } from "vitest";
import {
  CalendarServiceAdapter,
  type ProductionCalendarService,
} from "@/lib/context/adapters/calendarServiceAdapter";
import { CalendarSource } from "@/lib/context/sources/calendarSource";
import type { EventSummary } from "@/lib/services/calendar/types";
import type { RetrievalQuery } from "@/lib/context/types";

/** Build a valid production EventSummary fixture. */
function makeEvent(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: "evt-1",
    summary: "Design Review",
    description: "Review the new landing page mockups.",
    start: "2026-08-10T14:00:00Z",
    end: "2026-08-10T15:00:00Z",
    organizer: { email: "alice@example.com", displayName: "Alice Chen" },
    status: "confirmed",
    ...overrides,
  };
}

/** Mock production CalendarService with spy-able methods. */
interface MockProductionService extends ProductionCalendarService {
  createClientForUser: ReturnType<typeof vi.fn>;
  listEvents: ReturnType<typeof vi.fn>;
  searchEvents: ReturnType<typeof vi.fn>;
}

function makeService(
  overrides: {
    events?: EventSummary[];
    availabilityError?: unknown;
    searchError?: unknown;
    listError?: unknown;
  } = {},
): MockProductionService {
  const service = {
    createClientForUser: vi.fn(async () => {
      if (overrides.availabilityError !== undefined) throw overrides.availabilityError;
      return { client: {}, integration: { id: "int-1" } };
    }),
    listEvents: vi.fn(async () => {
      if (overrides.listError !== undefined) throw overrides.listError;
      return { events: overrides.events ?? [], nextPageToken: null };
    }),
    searchEvents: vi.fn(async () => {
      if (overrides.searchError !== undefined) throw overrides.searchError;
      return { events: overrides.events ?? [], nextPageToken: null };
    }),
  };
  return service as unknown as MockProductionService;
}

describe("CalendarServiceAdapter construction", () => {
  it("constructs with an injected mock production service", () => {
    const adapter = new CalendarServiceAdapter(makeService());
    expect(adapter).toBeInstanceOf(CalendarServiceAdapter);
  });

  it("constructs with the default production service (no arguments)", () => {
    const adapter = new CalendarServiceAdapter();
    expect(adapter).toBeInstanceOf(CalendarServiceAdapter);
  });

  it("stores the injected service and delegates to it", async () => {
    const service = makeService({ events: [makeEvent()] });
    const adapter = new CalendarServiceAdapter(service);
    const events = await adapter.retrieveRelevantEvents({
      userId: "user-1",
      query: "design",
      maxItems: 5,
    });
    expect(service.searchEvents).toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });
});

describe("CalendarServiceAdapter isAvailable", () => {
  it("returns true when createClientForUser resolves", async () => {
    const adapter = new CalendarServiceAdapter(makeService());
    await expect(adapter.isAvailable("user-1")).resolves.toBe(true);
  });

  it("returns false when createClientForUser rejects", async () => {
    const adapter = new CalendarServiceAdapter(
      makeService({ availabilityError: new Error("google_not_connected") }),
    );
    await expect(adapter.isAvailable("user-1")).resolves.toBe(false);
  });

  it("delegates to createClientForUser (no extra logic)", async () => {
    const service = makeService();
    const adapter = new CalendarServiceAdapter(service);
    await adapter.isAvailable("user-1");
    expect(service.createClientForUser).toHaveBeenCalledTimes(1);
    expect(service.createClientForUser).toHaveBeenCalledWith();
  });

  it("accepts a userId argument without error", async () => {
    const adapter = new CalendarServiceAdapter(makeService());
    await expect(adapter.isAvailable("any-user-id")).resolves.toBe(true);
  });

  it("does not retry on failure (createClientForUser called exactly once)", async () => {
    const service = makeService({ availabilityError: new Error("down") });
    const adapter = new CalendarServiceAdapter(service);
    await adapter.isAvailable("user-1");
    expect(service.createClientForUser).toHaveBeenCalledTimes(1);
  });

  it("does not cache: each call delegates again", async () => {
    const service = makeService();
    const adapter = new CalendarServiceAdapter(service);
    await adapter.isAvailable("user-1");
    await adapter.isAvailable("user-1");
    expect(service.createClientForUser).toHaveBeenCalledTimes(2);
  });

  it("always resolves to a boolean (never rejects)", async () => {
    const service = makeService({ availabilityError: new Error("boom") });
    const adapter = new CalendarServiceAdapter(service);
    await expect(adapter.isAvailable("user-1")).resolves.toBe(false);
  });
});

describe("CalendarServiceAdapter retrieveRelevantEvents delegation", () => {
  it("delegates a non-empty query to searchEvents with calendarId left undefined", async () => {
    const service = makeService({ events: [makeEvent()] });
    const adapter = new CalendarServiceAdapter(service);
    await adapter.retrieveRelevantEvents({ userId: "u", query: "design", maxItems: 5 });
    // production signature: searchEvents(q, calendarId?, maxResults?, pageToken?)
    expect(service.searchEvents).toHaveBeenCalledWith("design", undefined, 5);
    expect(service.listEvents).not.toHaveBeenCalled();
  });

  it("delegates an empty query to listEvents with { maxResults }", async () => {
    const service = makeService({ events: [makeEvent()] });
    const adapter = new CalendarServiceAdapter(service);
    await adapter.retrieveRelevantEvents({ userId: "u", query: "", maxItems: 5 });
    expect(service.listEvents).toHaveBeenCalledWith({ maxResults: 5 });
    expect(service.searchEvents).not.toHaveBeenCalled();
  });

  it("delegates a blank/whitespace-only query to listEvents", async () => {
    const service = makeService();
    const adapter = new CalendarServiceAdapter(service);
    await adapter.retrieveRelevantEvents({ userId: "u", query: "   ", maxItems: 3 });
    expect(service.listEvents).toHaveBeenCalledWith({ maxResults: 3 });
    expect(service.searchEvents).not.toHaveBeenCalled();
  });

  it("forwards a missing maxItems as undefined to searchEvents", async () => {
    const service = makeService();
    const adapter = new CalendarServiceAdapter(service);
    await adapter.retrieveRelevantEvents({ userId: "u", query: "design" });
    expect(service.searchEvents).toHaveBeenCalledWith("design", undefined, undefined);
  });

  it("forwards a missing maxItems as undefined to listEvents", async () => {
    const service = makeService();
    const adapter = new CalendarServiceAdapter(service);
    await adapter.retrieveRelevantEvents({ userId: "u", query: "" });
    expect(service.listEvents).toHaveBeenCalledWith({ maxResults: undefined });
  });

  it("passes a padded query verbatim to searchEvents (no trimming)", async () => {
    const service = makeService();
    const adapter = new CalendarServiceAdapter(service);
    await adapter.retrieveRelevantEvents({ userId: "u", query: "  design  ", maxItems: 2 });
    expect(service.searchEvents).toHaveBeenCalledWith("  design  ", undefined, 2);
  });

  it("accepts a history option without error", async () => {
    const service = makeService();
    const adapter = new CalendarServiceAdapter(service);
    await expect(
      adapter.retrieveRelevantEvents({
        userId: "u",
        query: "design",
        history: ["User: hi", "Assistant: hello"],
        maxItems: 5,
      }),
    ).resolves.toEqual([]);
  });

  it("preserves the production ordering without filtering or reranking", async () => {
    const events = [makeEvent({ id: "a" }), makeEvent({ id: "b" }), makeEvent({ id: "c" })];
    const adapter = new CalendarServiceAdapter(makeService({ events }));
    const result = await adapter.retrieveRelevantEvents({ userId: "u", query: "q", maxItems: 10 });
    expect(result.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });
});

describe("CalendarServiceAdapter mapping", () => {
  it("maps every compatible field", async () => {
    const event = makeEvent();
    const adapter = new CalendarServiceAdapter(makeService({ events: [event] }));
    const [mapped] = await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(mapped).toEqual({
      id: "evt-1",
      title: "Design Review",
      description: "Review the new landing page mockups.",
      startTime: "2026-08-10T14:00:00Z",
      endTime: "2026-08-10T15:00:00Z",
      organizer: "Alice Chen",
    });
  });

  it("maps the production summary to title", async () => {
    const adapter = new CalendarServiceAdapter(
      makeService({ events: [makeEvent({ summary: "Standup" })] }),
    );
    const [mapped] = await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(mapped.title).toBe("Standup");
  });

  it("normalizes a null summary to an empty title", async () => {
    const adapter = new CalendarServiceAdapter(makeService({ events: [makeEvent({ summary: null })] }));
    const [mapped] = await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(mapped.title).toBe("");
  });

  it("normalizes a null description to an empty string", async () => {
    const adapter = new CalendarServiceAdapter(
      makeService({ events: [makeEvent({ description: null })] }),
    );
    const [mapped] = await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(mapped.description).toBe("");
  });

  it("maps production start to startTime", async () => {
    const adapter = new CalendarServiceAdapter(
      makeService({ events: [makeEvent({ start: "2026-08-01T09:30:00Z" })] }),
    );
    const [mapped] = await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(mapped.startTime).toBe("2026-08-01T09:30:00Z");
  });

  it("maps a null start to an undefined startTime", async () => {
    const adapter = new CalendarServiceAdapter(makeService({ events: [makeEvent({ start: null })] }));
    const [mapped] = await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(mapped.startTime).toBeUndefined();
  });

  it("maps production end to endTime when available", async () => {
    const adapter = new CalendarServiceAdapter(
      makeService({ events: [makeEvent({ end: "2026-08-01T10:00:00Z" })] }),
    );
    const [mapped] = await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(mapped.endTime).toBe("2026-08-01T10:00:00Z");
  });

  it("maps a null end to an undefined endTime", async () => {
    const adapter = new CalendarServiceAdapter(makeService({ events: [makeEvent({ end: null })] }));
    const [mapped] = await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(mapped.endTime).toBeUndefined();
  });

  it("maps the organizer displayName", async () => {
    const adapter = new CalendarServiceAdapter(
      makeService({ events: [makeEvent({ organizer: { email: "bob@x.com", displayName: "Bob" } })] }),
    );
    const [mapped] = await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(mapped.organizer).toBe("Bob");
  });

  it("falls back to the organizer email when no displayName", async () => {
    const adapter = new CalendarServiceAdapter(
      makeService({ events: [makeEvent({ organizer: { email: "bob@x.com", displayName: null } })] }),
    );
    const [mapped] = await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(mapped.organizer).toBe("bob@x.com");
  });

  it("maps a null organizer to undefined", async () => {
    const adapter = new CalendarServiceAdapter(
      makeService({ events: [makeEvent({ organizer: null })] }),
    );
    const [mapped] = await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(mapped.organizer).toBeUndefined();
  });

  it("never invents a relevance score (omitted)", async () => {
    const adapter = new CalendarServiceAdapter(makeService({ events: [makeEvent()] }));
    const [mapped] = await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(mapped.relevance).toBeUndefined();
  });

  it("never invents an importance level (omitted)", async () => {
    const adapter = new CalendarServiceAdapter(makeService({ events: [makeEvent()] }));
    const [mapped] = await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(mapped.importance).toBeUndefined();
  });

  it("returns new event objects (not the production summary references)", async () => {
    const event = makeEvent();
    const adapter = new CalendarServiceAdapter(makeService({ events: [event] }));
    const [mapped] = await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(mapped).not.toBe(event);
  });

  it("does not mutate the production event objects", async () => {
    const event = makeEvent();
    const snapshot = JSON.parse(JSON.stringify(event)) as EventSummary;
    const adapter = new CalendarServiceAdapter(makeService({ events: [event] }));
    await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(event).toEqual(snapshot);
  });
});

describe("CalendarServiceAdapter responses", () => {
  it("returns an empty list for an empty production response", async () => {
    const adapter = new CalendarServiceAdapter(makeService({ events: [] }));
    await expect(
      adapter.retrieveRelevantEvents({ userId: "u", query: "q" }),
    ).resolves.toEqual([]);
  });

  it("maps multiple events preserving order", async () => {
    const events = [makeEvent({ id: "e1" }), makeEvent({ id: "e2" }), makeEvent({ id: "e3" })];
    const adapter = new CalendarServiceAdapter(makeService({ events }));
    const result = await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(result.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
  });

  it("handles a large production response", async () => {
    const events = Array.from({ length: 1000 }, (_, i) => makeEvent({ id: `evt-${i}` }));
    const adapter = new CalendarServiceAdapter(makeService({ events }));
    const result = await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(result).toHaveLength(1000);
    expect(result[999].id).toBe("evt-999");
  });

  it("is deterministic across repeated calls", async () => {
    const events = [makeEvent({ id: "a" }), makeEvent({ id: "b" })];
    const adapter = new CalendarServiceAdapter(makeService({ events }));
    const options = { userId: "u", query: "q" };
    const first = await adapter.retrieveRelevantEvents(options);
    const second = await adapter.retrieveRelevantEvents(options);
    expect(second).toEqual(first);
  });
});

describe("CalendarServiceAdapter error propagation", () => {
  it("forwards an async searchEvents rejection (never swallowed)", async () => {
    const error = new Error("calendar search down");
    const adapter = new CalendarServiceAdapter(makeService({ searchError: error }));
    await expect(
      adapter.retrieveRelevantEvents({ userId: "u", query: "q" }),
    ).rejects.toBe(error);
  });

  it("forwards an async listEvents rejection (never swallowed)", async () => {
    const error = new Error("calendar list down");
    const adapter = new CalendarServiceAdapter(makeService({ listError: error }));
    await expect(
      adapter.retrieveRelevantEvents({ userId: "u", query: "" }),
    ).rejects.toBe(error);
  });

  it("forwards a synchronous searchEvents throw", async () => {
    const error = new Error("sync boom");
    const service = makeService();
    service.searchEvents.mockImplementation(() => {
      throw error;
    });
    const adapter = new CalendarServiceAdapter(service);
    await expect(
      adapter.retrieveRelevantEvents({ userId: "u", query: "q" }),
    ).rejects.toBe(error);
  });

  it("forwards a synchronous listEvents throw", async () => {
    const error = new Error("sync list boom");
    const service = makeService();
    service.listEvents.mockImplementation(() => {
      throw error;
    });
    const adapter = new CalendarServiceAdapter(service);
    await expect(
      adapter.retrieveRelevantEvents({ userId: "u", query: "" }),
    ).rejects.toBe(error);
  });
});

describe("CalendarServiceAdapter retry behavior", () => {
  it("calls searchEvents exactly once on success", async () => {
    const service = makeService({ events: [makeEvent()] });
    const adapter = new CalendarServiceAdapter(service);
    await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(service.searchEvents).toHaveBeenCalledTimes(1);
  });

  it("calls listEvents exactly once on success", async () => {
    const service = makeService({ events: [makeEvent()] });
    const adapter = new CalendarServiceAdapter(service);
    await adapter.retrieveRelevantEvents({ userId: "u", query: "" });
    expect(service.listEvents).toHaveBeenCalledTimes(1);
  });

  it("never retries a failing search (single delegation)", async () => {
    const service = makeService({ searchError: new Error("down") });
    const adapter = new CalendarServiceAdapter(service);
    await adapter.retrieveRelevantEvents({ userId: "u", query: "q" }).catch(() => undefined);
    expect(service.searchEvents).toHaveBeenCalledTimes(1);
  });
});

describe("CalendarServiceAdapter immutability", () => {
  it("does not mutate the options object passed to retrieveRelevantEvents", async () => {
    const service = makeService({ events: [makeEvent()] });
    const adapter = new CalendarServiceAdapter(service);
    const options = { userId: "u", query: "design", history: ["hi"], maxItems: 5 };
    const snapshot = { ...options };
    await adapter.retrieveRelevantEvents(options);
    expect(options).toEqual(snapshot);
  });

  it("does not mutate the production events array", async () => {
    const events = [makeEvent({ id: "a" }), makeEvent({ id: "b" })];
    const snapshot = JSON.parse(JSON.stringify(events)) as EventSummary[];
    const adapter = new CalendarServiceAdapter(makeService({ events }));
    await adapter.retrieveRelevantEvents({ userId: "u", query: "q" });
    expect(events).toEqual(snapshot);
  });
});

describe("CalendarServiceAdapter CalendarSource integration", () => {
  it("satisfies the CalendarSource contract end-to-end", async () => {
    const service = makeService({
      events: [makeEvent({ id: "e1", summary: "Standup", description: "Daily sync", start: "2026-08-10T09:00:00Z" })],
    });
    const adapter = new CalendarServiceAdapter(service);
    const source = new CalendarSource(adapter);
    const query: RetrievalQuery = { userId: "user-1", query: "standup" };
    const contexts = await source.retrieve(query);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      id: "e1",
      source: "calendar",
      title: "Standup",
      content: "Daily sync",
    });
    expect(service.searchEvents).toHaveBeenCalledWith("standup", undefined, undefined);
  });

  it("drives CalendarSource isAvailable through the adapter", async () => {
    const adapter = new CalendarServiceAdapter(makeService());
    const source = new CalendarSource(adapter);
    await expect(source.isAvailable("user-1")).resolves.toBe(true);
  });

  it("reports unavailability through CalendarSource when the service rejects", async () => {
    const adapter = new CalendarServiceAdapter(
      makeService({ availabilityError: new Error("not connected") }),
    );
    const source = new CalendarSource(adapter);
    await expect(source.isAvailable("user-1")).resolves.toBe(false);
  });

  it("defaults relevance to 0.5 downstream when the adapter omits it", async () => {
    const adapter = new CalendarServiceAdapter(makeService({ events: [makeEvent()] }));
    const source = new CalendarSource(adapter);
    const contexts = await source.retrieve({ userId: "u", query: "q" });
    expect(contexts[0].relevance).toBe(0.5);
  });
});
