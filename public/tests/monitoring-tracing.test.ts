import { describe, it, expect } from "vitest";
import {
  SPAN_KINDS,
  TraceStore,
  cloneSpan,
  createRootTrace,
  createSpan,
  createTraceStore,
  freezeSpan,
  hashSpan,
  spanEventIdFor,
  spanIdFor,
  spanReference,
  traceStatistics,
  traceSummaries,
  tracesFromSpans,
  type SpanKind,
} from "@/lib/monitoring/tracing";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:00:01.000Z";

describe("spanIdFor / createSpan / createSpanEvent", () => {
  it("derives deterministic span ids", () => {
    const a = spanIdFor({ traceId: "t1", kind: "api", name: "GET /x", startedAt: NOW });
    const b = spanIdFor({ traceId: "t1", kind: "api", name: "GET /x", startedAt: NOW });
    const c = spanIdFor({ traceId: "t1", kind: "api", name: "GET /y", startedAt: NOW });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^span-[0-9a-f]{8}$/);
  });

  it("deep-freezes spans and attributes", () => {
    const span = createSpan({
      traceId: "t1",
      kind: "workflow",
      name: "wf",
      startedAt: NOW,
      attributes: { a: 1 },
    });
    expect(Object.isFrozen(span)).toBe(true);
    expect(span.attributes && Object.isFrozen(span.attributes)).toBe(true);
  });

  it("spanEventIdFor is deterministic", () => {
    expect(spanEventIdFor({ spanId: "s1", name: "start", timestamp: NOW })).toBe(
      spanEventIdFor({ spanId: "s1", name: "start", timestamp: NOW }),
    );
  });
});

describe("clone / freeze / hash / reference", () => {
  it("cloneSpan returns a detached mutable copy", () => {
    const span = createSpan({ traceId: "t1", kind: "tool", name: "search", startedAt: NOW });
    const clone = cloneSpan(span);
    expect(clone).toEqual(span);
    expect(clone).not.toBe(span);
    expect(Object.isFrozen(clone)).toBe(false);
  });

  it("freezeSpan freezes nested events", () => {
    const store = createTraceStore();
    const started = store.start({ kind: "root", name: "r", startedAt: NOW });
    const withEvent = started.store.addEvent(started.span.id, "begin", NOW);
    const span = withEvent.store.find(started.span.id);
    if (span !== undefined) {
      const frozen = freezeSpan(span);
      expect(Object.isFrozen(frozen)).toBe(true);
      expect(Object.isFrozen(frozen.events[0])).toBe(true);
    }
    expect(span).toBeDefined();
  });

  it("hashSpan is stable and sensitive", () => {
    const a = createSpan({ traceId: "t1", kind: "api", name: "x", startedAt: NOW });
    const b = createSpan({ traceId: "t1", kind: "api", name: "x", startedAt: NOW });
    const c = createSpan({ traceId: "t1", kind: "api", name: "y", startedAt: NOW });
    expect(hashSpan(a)).toBe(hashSpan(b));
    expect(hashSpan(a)).not.toBe(hashSpan(c));
  });

  it("spanReference projects a lightweight link", () => {
    const span = createSpan({ traceId: "t1", kind: "database", name: "query", startedAt: NOW });
    expect(spanReference(span)).toEqual({
      traceId: "t1",
      spanId: span.id,
      kind: "database",
      name: "query",
    });
  });
});

describe("TraceStore.start / finish / addEvent", () => {
  it("start returns a successor store; receiver never mutates", () => {
    const store = createTraceStore();
    const { store: next, span } = store.start({ kind: "api", name: "request", startedAt: NOW });
    expect(span.kind).toBe("api");
    expect(store.count()).toBe(0);
    expect(next.count()).toBe(1);
  });

  it("children share the parent trace id", () => {
    const store = createTraceStore();
    const root = store.start({ kind: "root", name: "r", startedAt: NOW });
    const child = root.store.start({
      parentSpanId: root.span.id,
      kind: "database",
      name: "query",
      startedAt: NOW,
    });
    expect(child.span.traceId).toBe(root.span.traceId);
    expect(child.span.parentSpanId).toBe(root.span.id);
  });

  it("finish closes a span with duration and optional error", () => {
    const store = createTraceStore();
    const started = store.start({ kind: "tool", name: "search", startedAt: NOW });
    const finished = started.store.finish(started.span.id, LATER, {
      error: { code: "timeout", message: "timed out" },
    });
    expect(finished.span?.finishedAt).toBe(LATER);
    expect(finished.span?.durationMs).toBe(1000);
    expect(finished.span?.error).toEqual({ code: "timeout", message: "timed out" });
    expect(started.store.find(started.span.id)?.finishedAt).toBeUndefined();
  });

  it("finish on an unknown span is a no-op", () => {
    const store = createTraceStore();
    const finished = store.finish("nope", LATER);
    expect(finished.span).toBeUndefined();
    expect(finished.store.count()).toBe(0);
  });

  it("addEvent attaches immutable events", () => {
    const store = createTraceStore();
    const started = store.start({ kind: "workflow", name: "wf", startedAt: NOW });
    const withEvent = started.store.addEvent(started.span.id, "step-1", NOW, { step: 1 });
    expect(withEvent.event?.name).toBe("step-1");
    expect(withEvent.store.find(started.span.id)?.events).toHaveLength(1);
  });

  it("start a child of an unknown span throws", () => {
    const store = createTraceStore();
    expect(() => store.start({ parentSpanId: "nope", kind: "tool", name: "x", startedAt: NOW })).toThrow();
  });

  it("bounds retained spans with maxSpans", () => {
    const store = new TraceStore({ maxSpans: 2 });
    let current = store;
    for (let index = 0; index < 3; index += 1) {
      const { store: next } = current.start({ kind: "api", name: `r${index}`, startedAt: NOW });
      current = next;
    }
    expect(current.count()).toBe(2);
  });
});

describe("aggregation", () => {
  it("traceStatistics counts open/finished/errored and per-kind", () => {
    const store = createTraceStore();
    const root = store.start({ kind: "root", name: "r", startedAt: NOW });
    const child = root.store.start({ parentSpanId: root.span.id, kind: "database", name: "q", startedAt: NOW });
    const finishedChild = child.store.finish(child.span.id, LATER, {
      error: { code: "error", message: "boom" },
    });
    const stats = finishedChild.store.statistics();
    expect(stats.totalSpans).toBe(2);
    expect(stats.openSpans).toBe(1);
    expect(stats.finishedSpans).toBe(1);
    expect(stats.erroredSpans).toBe(1);
    expect(stats.byKind.database).toBe(1);
    expect(stats.byKind.root).toBe(1);
  });

  it("traceStatistics over empty spans", () => {
    const stats = traceStatistics([]);
    expect(stats.totalSpans).toBe(0);
    expect(stats.averageDurationMs).toBeUndefined();
  });

  it("tracesFromSpans groups by trace with root first", () => {
    const store = createTraceStore();
    const root = store.start({ kind: "root", name: "r", startedAt: NOW });
    const child = root.store.start({ parentSpanId: root.span.id, kind: "tool", name: "t", startedAt: NOW });
    const other = child.store.start({ kind: "root", name: "other", startedAt: NOW });
    const traces = tracesFromSpans(other.store.spans);
    expect(traces).toHaveLength(2);
    const first = traces[0];
    expect(first?.rootSpanId).toBe(root.span.id);
    expect(first?.spans).toHaveLength(2);
  });

  it("traceSummaries produce compact per-trace views", () => {
    const store = createTraceStore();
    const root = store.start({ kind: "root", name: "r", startedAt: NOW });
    const summaries = traceSummaries(root.store.spans);
    expect(summaries[0]?.spanCount).toBe(1);
    expect(summaries[0]?.openCount).toBe(1);
    expect(summaries[0]?.erroredCount).toBe(0);
  });

  it("createRootTrace builds a root trace with a stable id", () => {
    const a = createRootTrace({ kind: "api", name: "GET /x", startedAt: NOW });
    const b = createRootTrace({ kind: "api", name: "GET /x", startedAt: NOW });
    expect(a.trace.traceId).toBe(b.trace.traceId);
    expect(a.span.traceId).toBe(a.trace.traceId);
    expect(a.trace.rootSpanId).toBe(a.span.id);
    expect(a.store.count()).toBe(1);
  });
});

describe("snapshot", () => {
  it("builds a deterministic snapshot at `at`", () => {
    const store = createTraceStore();
    const root = store.start({ kind: "root", name: "r", startedAt: NOW });
    const snapshot = root.store.snapshot(LATER);
    expect(snapshot.at).toBe(LATER);
    expect(snapshot.spans).toHaveLength(1);
    expect(snapshot.statistics.totalSpans).toBe(1);
    expect(snapshot.summaries).toHaveLength(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

describe("SPAN_KINDS", () => {
  it("covers every supported span kind", () => {
    const kinds: readonly SpanKind[] = [
      "root",
      "api",
      "worker",
      "workflow",
      "job",
      "action",
      "digest",
      "memory",
      "conversation",
      "context",
      "planner",
      "tool",
      "database",
      "persistence",
      "queue",
      "llm",
      "event",
      "notification",
    ];
    expect(SPAN_KINDS).toEqual(kinds);
  });
});
