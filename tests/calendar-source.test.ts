import { describe, it, expect, vi } from "vitest";
import { CalendarSource } from "@/lib/context/sources/calendarSource";
import { ContextSourceBase } from "@/lib/context/sources/contextSource";
import { estimateTokens } from "@/lib/context/tokenBudget";
import type { CalendarEvent, CalendarService } from "@/lib/context/sources/calendarSource";
import type { RetrievalQuery } from "@/lib/context/types";

/** Build a valid CalendarEvent fixture. */
function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "event-1",
    title: "Weekly Sync",
    description: "Review sprint progress and plan next week.",
    startTime: "2026-08-10T09:00:00Z",
    endTime: "2026-08-10T10:00:00Z",
    relevance: 0.9,
    organizer: "carol@example.com",
    importance: "high",
    ...overrides,
  };
}

/** Build a valid RetrievalQuery fixture. */
function makeQuery(overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    userId: "user-1",
    query: "upcoming meetings",
    history: ["User: hi", "Assistant: hello"],
    maxItems: 5,
    ...overrides,
  };
}

interface MockService extends CalendarService {
  isAvailable: ReturnType<typeof vi.fn>;
  retrieveRelevantEvents: ReturnType<typeof vi.fn>;
}

/** Build a fully mocked CalendarService. */
function makeService(
  overrides: { available?: boolean; events?: CalendarEvent[]; error?: unknown } = {},
): MockService {
  const service = {
    isAvailable: vi.fn(async (): Promise<boolean> => {
      if (overrides.error !== undefined) throw overrides.error;
      return overrides.available ?? true;
    }),
    retrieveRelevantEvents: vi.fn(async (): Promise<CalendarEvent[]> => {
      if (overrides.error !== undefined) throw overrides.error;
      return overrides.events ?? [];
    }),
  };
  return service as unknown as MockService;
}

describe("CalendarSource identity", () => {
  it("exposes the id 'calendar'", () => {
    expect(new CalendarSource(makeService()).id).toBe("calendar");
  });

  it("exposes priority 60", () => {
    expect(new CalendarSource(makeService()).priority).toBe(60);
  });

  it("extends ContextSourceBase", () => {
    expect(new CalendarSource(makeService())).toBeInstanceOf(ContextSourceBase);
  });

  it("stores the injected service for later calls", async () => {
    const service = makeService({ events: [makeEvent()] });
    const source = new CalendarSource(service);
    const contexts = await source.retrieve(makeQuery());
    expect(service.retrieveRelevantEvents).toHaveBeenCalled();
    expect(contexts).toHaveLength(1);
  });
});

describe("CalendarSource isAvailable", () => {
  it("forwards to the calendar service", async () => {
    const service = makeService({ available: true });
    const source = new CalendarSource(service);
    await expect(source.isAvailable("user-1")).resolves.toBe(true);
    expect(service.isAvailable).toHaveBeenCalledWith("user-1");
  });

  it("returns false when the service reports unavailable", async () => {
    const source = new CalendarSource(makeService({ available: false }));
    await expect(source.isAvailable("user-9")).resolves.toBe(false);
  });

  it("passes the exact userId through", async () => {
    const service = makeService();
    const source = new CalendarSource(service);
    await source.isAvailable("some-user-id");
    expect(service.isAvailable).toHaveBeenCalledWith("some-user-id");
  });

  it("propagates a service rejection (no extra logic in isAvailable)", async () => {
    const error = new Error("calendar service down");
    const source = new CalendarSource(makeService({ error }));
    await expect(source.isAvailable("user-1")).rejects.toBe(error);
  });
});

describe("CalendarSource retrieve service call", () => {
  it("calls retrieveRelevantEvents with the query fields", async () => {
    const service = makeService();
    const source = new CalendarSource(service);
    const query = makeQuery();
    await source.retrieve(query);
    expect(service.retrieveRelevantEvents).toHaveBeenCalledWith({
      userId: "user-1",
      query: "upcoming meetings",
      history: ["User: hi", "Assistant: hello"],
      maxItems: 5,
    });
  });

  it("forwards missing optional fields as undefined", async () => {
    const service = makeService();
    const source = new CalendarSource(service);
    await source.retrieve(makeQuery({ history: undefined, maxItems: undefined }));
    expect(service.retrieveRelevantEvents).toHaveBeenCalledWith({
      userId: "user-1",
      query: "upcoming meetings",
      history: undefined,
      maxItems: undefined,
    });
  });
});

describe("CalendarSource Context mapping", () => {
  it("maps every field of an event to a Context", async () => {
    const event = makeEvent();
    const source = new CalendarSource(makeService({ events: [event] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context).toMatchObject({
      id: "event-1",
      source: "calendar",
      title: "Weekly Sync",
      content: "Review sprint progress and plan next week.",
      timestamp: "2026-08-10T09:00:00Z",
      relevance: 0.9,
      truncated: false,
      compressed: false,
      permissions: null,
    });
  });

  it("sets source to 'calendar'", async () => {
    const source = new CalendarSource(makeService({ events: [makeEvent()] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.source).toBe("calendar");
  });

  it("maps the title and description", async () => {
    const source = new CalendarSource(
      makeService({ events: [makeEvent({ title: "All Hands", description: "Company meeting" })] }),
    );
    const [context] = await source.retrieve(makeQuery());
    expect(context.title).toBe("All Hands");
    expect(context.content).toBe("Company meeting");
  });

  it("computes tokenEstimate with estimateTokens(description)", async () => {
    const event = makeEvent({ description: "short description" });
    const source = new CalendarSource(makeService({ events: [event] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.tokenEstimate).toBe(estimateTokens("short description"));
    expect(context.tokenEstimate).toBe(Math.ceil("short description".length / 4));
  });

  it("estimates tokens for an empty description as 0", async () => {
    const source = new CalendarSource(makeService({ events: [makeEvent({ description: "" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.tokenEstimate).toBe(0);
  });

  it("maps a null startTime to null", async () => {
    const source = new CalendarSource(makeService({ events: [makeEvent({ startTime: null })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.timestamp).toBeNull();
  });

  it("maps a missing startTime (undefined) to null", async () => {
    const source = new CalendarSource(makeService({ events: [makeEvent({ startTime: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.timestamp).toBeNull();
  });

  it("keeps a provided startTime verbatim", async () => {
    const source = new CalendarSource(
      makeService({ events: [makeEvent({ startTime: "2026-08-02T10:00:00Z" })] }),
    );
    const [context] = await source.retrieve(makeQuery());
    expect(context.timestamp).toBe("2026-08-02T10:00:00Z");
  });

  it("defaults relevance to 0.5 when missing", async () => {
    const source = new CalendarSource(makeService({ events: [makeEvent({ relevance: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.relevance).toBe(0.5);
  });

  it("keeps an explicit relevance score", async () => {
    const source = new CalendarSource(makeService({ events: [makeEvent({ relevance: 0.3 })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.relevance).toBe(0.3);
  });

  it("sets metadata.kind to 'event' and entityId to the event id", async () => {
    const source = new CalendarSource(makeService({ events: [makeEvent({ id: "event-42" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.kind).toBe("event");
    expect(context.metadata.entityId).toBe("event-42");
  });

  it("maps metadata.author from the organizer", async () => {
    const source = new CalendarSource(makeService({ events: [makeEvent({ organizer: "bob@x.com" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.author).toBe("bob@x.com");
  });

  it("leaves metadata.author undefined when there is no organizer", async () => {
    const source = new CalendarSource(makeService({ events: [makeEvent({ organizer: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.author).toBeUndefined();
  });

  it("maps metadata.importance from the event", async () => {
    const source = new CalendarSource(makeService({ events: [makeEvent({ importance: "critical" })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.importance).toBe("critical");
  });

  it("omits importance when the event has none", async () => {
    const source = new CalendarSource(makeService({ events: [makeEvent({ importance: undefined })] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.importance).toBeUndefined();
  });

  it("stores the original event object in metadata.raw", async () => {
    const event = makeEvent({ description: "unique raw payload", importance: "low" });
    const source = new CalendarSource(makeService({ events: [event] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.metadata.raw).toBe(event);
  });

  it("sets permissions to null", async () => {
    const source = new CalendarSource(makeService({ events: [makeEvent()] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.permissions).toBeNull();
  });

  it("marks the context as neither truncated nor compressed", async () => {
    const source = new CalendarSource(makeService({ events: [makeEvent()] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context.truncated).toBe(false);
    expect(context.compressed).toBe(false);
  });

  it("ignores endTime (not mapped in this phase)", async () => {
    const source = new CalendarSource(
      makeService({ events: [makeEvent({ endTime: "2026-08-10T11:00:00Z" })] }),
    );
    const [context] = await source.retrieve(makeQuery());
    expect(context).not.toHaveProperty("endTime");
    expect(context.metadata).not.toHaveProperty("endTime");
  });
});

describe("CalendarSource error handling", () => {
  it("returns [] when the service rejects", async () => {
    const source = new CalendarSource(makeService({ error: new Error("service boom") }));
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });

  it("returns [] when the service throws synchronously", async () => {
    const service = {
      isAvailable: vi.fn(async () => true),
      retrieveRelevantEvents: vi.fn((): Promise<CalendarEvent[]> => {
        throw new Error("sync boom");
      }),
    } as unknown as CalendarService;
    const source = new CalendarSource(service);
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });

  it("never throws for a failing service", async () => {
    const source = new CalendarSource(makeService({ error: new Error("down") }));
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });
});

describe("CalendarSource result behavior", () => {
  it("returns an empty array for an empty event list", async () => {
    const source = new CalendarSource(makeService({ events: [] }));
    await expect(source.retrieve(makeQuery())).resolves.toEqual([]);
  });

  it("maps multiple events", async () => {
    const events = [makeEvent({ id: "a" }), makeEvent({ id: "b" }), makeEvent({ id: "c" })];
    const source = new CalendarSource(makeService({ events }));
    const contexts = await source.retrieve(makeQuery());
    expect(contexts).toHaveLength(3);
    expect(contexts.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("preserves the service's ordering", async () => {
    const events = [
      makeEvent({ id: "first", relevance: 0.9 }),
      makeEvent({ id: "second", relevance: 0.4 }),
      makeEvent({ id: "third", relevance: 0.1 }),
    ];
    const source = new CalendarSource(makeService({ events }));
    const contexts = await source.retrieve(makeQuery());
    expect(contexts.map((c) => c.id)).toEqual(["first", "second", "third"]);
  });

  it("is deterministic across repeated calls", async () => {
    const events = [makeEvent({ id: "a" }), makeEvent({ id: "b" })];
    const source = new CalendarSource(makeService({ events }));
    const first = await source.retrieve(makeQuery());
    const second = await source.retrieve(makeQuery());
    expect(second).toEqual(first);
  });
});

describe("CalendarSource immutability", () => {
  it("does not mutate the retrieval query", async () => {
    const query = makeQuery();
    const snapshot = JSON.parse(JSON.stringify(query)) as RetrievalQuery;
    const source = new CalendarSource(makeService({ events: [makeEvent()] }));
    await source.retrieve(query);
    expect(query).toEqual(snapshot);
  });

  it("does not mutate the event objects", async () => {
    const event = makeEvent({ description: "original" });
    const snapshot = JSON.parse(JSON.stringify(event)) as CalendarEvent;
    const source = new CalendarSource(makeService({ events: [event] }));
    await source.retrieve(makeQuery());
    expect(event).toEqual(snapshot);
  });

  it("returns new Context objects (not the event references)", async () => {
    const event = makeEvent();
    const source = new CalendarSource(makeService({ events: [event] }));
    const [context] = await source.retrieve(makeQuery());
    expect(context).not.toBe(event);
    expect(context.metadata.raw).toBe(event);
  });
});
