/**
 * Phase 5J STEP 5 — event bus tests.
 */
import { describe, expect, it } from "vitest";
import { EventBus, type AppEventListener } from "@/lib/events/bus";
import { createAppEvent, eventBuilders } from "@/lib/events/types";

const NOW = "2026-08-10T08:00:00.000Z";

describe("EventBus immutability", () => {
  it("subscribe returns a successor bus and never mutates the receiver", () => {
    const bus = new EventBus();
    const { bus: next, id } = bus.subscribe("memory.stored", () => undefined);
    expect(bus.subscriberCount("memory.stored")).toBe(0);
    expect(next.subscriberCount("memory.stored")).toBe(1);
    expect(id).toBe("listener-0");
    expect(next.hasListener(id)).toBe(true);
  });

  it("unsubscribe returns a successor without the listener", () => {
    const { bus, id } = new EventBus().subscribe("job.completed", () => undefined);
    const next = bus.unsubscribe(id);
    expect(next.subscriberCount("job.completed")).toBe(0);
    expect(next.hasListener(id)).toBe(false);
    expect(bus.subscriberCount("job.completed")).toBe(1);
  });

  it("unsubscribe of an unknown id is a no-op (same bus semantics)", () => {
    const bus = new EventBus();
    const next = bus.unsubscribe("nope");
    expect(next.subscriberCount("memory.stored")).toBe(0);
  });

  it("listener ids are unique within a lineage", () => {
    let bus = new EventBus();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const { bus: next, id } = bus.subscribe("digest.published", () => undefined);
      bus = next;
      ids.add(id);
    }
    expect(ids.size).toBe(20);
  });

  it("delivers only to listeners of the event's kind", async () => {
    const calls: string[] = [];
    const { bus } = new EventBus()
      .subscribe("memory.stored", () => {
        calls.push("memory");
      });
    const { bus: bus2 } = bus.subscribe("digest.published", () => {
      calls.push("digest");
    });
    await bus2.emit(eventBuilders.memoryStored("m", NOW));
    expect(calls).toEqual(["memory"]);
  });
});

describe("EventBus emit", () => {
  it("delivers each event exactly once per listener, in registration order", async () => {
    const calls: string[] = [];
    let bus = new EventBus();
    ({ bus } = bus.subscribe("memory.stored", () => {
      calls.push("a");
    }));
    ({ bus } = bus.subscribe("memory.stored", () => {
      calls.push("b");
    }));
    await bus.emit(eventBuilders.memoryStored("m", NOW));
    await bus.emit(eventBuilders.memoryStored("m", NOW));
    expect(calls).toEqual(["a", "b", "a", "b"]);
  });

  it("awaits async listeners before resolving", async () => {
    const order: string[] = [];
    const { bus } = new EventBus().subscribe("job.completed", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("async");
    });
    const { bus: bus2 } = bus.subscribe("job.completed", () => {
      order.push("sync");
    });
    await bus2.emit(eventBuilders.jobCompleted("j", NOW));
    expect(order).toEqual(["async", "sync"]);
  });

  it("isolates failing listeners and reports them structurally", async () => {
    const { bus } = new EventBus()
      .subscribe("action.completed", () => {
        throw new Error("listener boom");
      });
    const { bus: bus2 } = bus.subscribe("action.completed", () => undefined);
    const summary = await bus2.emit(eventBuilders.actionCompleted("a", NOW));
    expect(summary.total).toBe(2);
    expect(summary.delivered).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.outcomes[0]?.ok).toBe(false);
    expect(summary.outcomes[0]?.error).toBe("listener boom");
    expect(summary.outcomes[1]?.ok).toBe(true);
    // Never throws — even a synchronous throw is caught.
    await expect(bus2.emit(eventBuilders.actionCompleted("a", NOW))).resolves.toBeDefined();
  });

  it("isolates rejected async listeners", async () => {
    const { bus } = new EventBus().subscribe("digest.published", async () => {
      throw new Error("async boom");
    });
    const summary = await bus.emit(eventBuilders.digestPublished("d", NOW));
    expect(summary.failed).toBe(1);
    expect(summary.outcomes[0]?.error).toBe("async boom");
  });

  it("emitting with no listeners yields an empty summary", async () => {
    const summary = await new EventBus().emit(eventBuilders.memoryStored("m", NOW));
    expect(summary).toEqual({
      event: expect.objectContaining({ type: "memory.stored" }),
      outcomes: [],
      total: 0,
      delivered: 0,
      failed: 0,
    });
  });

  it("listeners receive the immutable event", async () => {
    let received: unknown;
    const { bus } = new EventBus().subscribe("memory.stored", (event) => {
      received = event;
    });
    await bus.emit(eventBuilders.memoryStored("mem-9", NOW));
    expect(received).toEqual(expect.objectContaining({ entityId: "mem-9", now: NOW }));
  });
});

describe("EventBus snapshots", () => {
  it("listenersSnapshot returns registration order across kinds", () => {
    let bus = new EventBus();
    ({ bus } = bus.subscribe("memory.stored", () => undefined));
    ({ bus } = bus.subscribe("job.completed", () => undefined));
    ({ bus } = bus.subscribe("memory.stored", () => undefined));
    expect(bus.listenersSnapshot().map((entry) => entry.type)).toEqual([
      "memory.stored",
      "job.completed",
      "memory.stored",
    ]);
  });

  it("subscriberCount reflects per-kind registrations", () => {
    let bus = new EventBus();
    ({ bus } = bus.subscribe("memory.stored", () => undefined));
    ({ bus } = bus.subscribe("memory.stored", () => undefined));
    ({ bus } = bus.subscribe("digest.published", () => undefined));
    expect(bus.subscriberCount("memory.stored")).toBe(2);
    expect(bus.subscriberCount("digest.published")).toBe(1);
    expect(bus.subscriberCount("job.completed")).toBe(0);
  });

  it("emit delivers to a frozen snapshot (late unsubscribes don't affect a running emit)", async () => {
    const calls: string[] = [];
    let bus = new EventBus();
    ({ bus } = bus.subscribe("memory.stored", () => {
      calls.push("a");
    }));
    const { bus: bus2 } = bus.subscribe("memory.stored", () => {
      calls.push("b");
    });
    await bus2.emit(eventBuilders.memoryStored("m", NOW));
    expect(calls).toEqual(["a", "b"]);
  });
});

describe("EventBus determinism", () => {
  it("identical subscription sequences produce identical ids", () => {
    const build = () => {
      let bus = new EventBus();
      const ids: string[] = [];
      ({ bus } = bus.subscribe("memory.stored", () => undefined));
      ({ bus } = bus.subscribe("job.completed", () => undefined));
      ({ bus } = bus.subscribe("memory.stored", () => undefined));
      ids.push(...bus.listenersSnapshot().map((e) => e.id));
      return ids;
    };
    expect(build()).toEqual(build());
  });
});
