/**
 * Observability & Monitoring — distributed tracing (Phase 6C STEP 4).
 *
 * Immutable trace/span model: a `TraceStore` is a successor-based collector
 * of spans; `start()` returns a successor store plus an open span, and
 * `finish()` closes it into a new successor. Spans never mutate.
 *
 * Supports parent/child relationships (workflow → tool/database/planner →
 * …), span events and typed span kinds. All timestamps are caller-supplied.
 */

import { hashString } from "@/lib/hash";

/** The kind of work a span represents. */
export type SpanKind =
  | "root"
  | "api"
  | "worker"
  | "workflow"
  | "job"
  | "action"
  | "digest"
  | "memory"
  | "conversation"
  | "context"
  | "planner"
  | "tool"
  | "database"
  | "persistence"
  | "queue"
  | "llm"
  | "event"
  | "notification";

/** Every span kind in a stable canonical order. */
export const SPAN_KINDS: readonly SpanKind[] = Object.freeze([
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
]);

/** A lightweight reference to a span (for linking). */
export interface SpanReference {
  readonly traceId: string;
  readonly spanId: string;
  readonly kind: SpanKind;
  readonly name: string;
}

/** A point-in-time event recorded on a span. */
export interface SpanEvent {
  /** Stable id: `sevent-<hash(spanId:name:timestamp)>`. */
  readonly id: string;
  readonly name: string;
  readonly timestamp: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** The context a span runs in (parent linkage). */
export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
  /** The parent span id, when nested. */
  readonly parentSpanId?: string;
  readonly kind: SpanKind;
}

/** An immutable span. */
export interface Span {
  readonly id: string;
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly kind: SpanKind;
  readonly name: string;
  /** ISO-8601 UTC timestamps, caller-supplied. */
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly events: readonly SpanEvent[];
  /** Structured error attached on failure, when applicable. */
  readonly error?: Readonly<{ code: string; message: string }>;
  /** Derivable latency in milliseconds (finished spans only). */
  readonly durationMs?: number;
}

/** An immutable trace (root span + descendant spans). */
export interface Trace {
  readonly traceId: string;
  readonly rootSpanId: string;
  readonly spans: readonly Span[];
}

/** Input accepted by {@link createSpan}. */
export interface CreateSpanInput {
  readonly traceId: string;
  readonly id?: string;
  readonly parentSpanId?: string;
  readonly kind: SpanKind;
  readonly name: string;
  readonly startedAt: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** Input accepted by {@link TraceStore.start}. */
export interface StartSpanInput {
  readonly parentSpanId?: string;
  readonly kind: SpanKind;
  readonly name: string;
  readonly startedAt: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** Deterministic id for a span. */
export function spanIdFor(input: {
  readonly traceId: string;
  readonly kind: SpanKind;
  readonly name: string;
  readonly startedAt: string;
}): string {
  return `span-${hashString(`${input.traceId}:${input.kind}:${input.name}:${input.startedAt}`)}`;
}

/** Deterministic id for a span event. */
export function spanEventIdFor(input: {
  readonly spanId: string;
  readonly name: string;
  readonly timestamp: string;
}): string {
  return `sevent-${hashString(`${input.spanId}:${input.name}:${input.timestamp}`)}`;
}

/** Build a new immutable span (deep-frozen). */
export function createSpan(input: CreateSpanInput): Span {
  const id = input.id ?? spanIdFor(input);
  return Object.freeze({
    id,
    traceId: input.traceId,
    ...(input.parentSpanId !== undefined ? { parentSpanId: input.parentSpanId } : {}),
    kind: input.kind,
    name: input.name,
    startedAt: input.startedAt,
    ...(input.attributes !== undefined
      ? { attributes: Object.freeze({ ...input.attributes }) }
      : {}),
    events: Object.freeze([]),
  });
}

/** Build a new immutable span event. */
export function createSpanEvent(input: {
  readonly spanId: string;
  readonly name: string;
  readonly timestamp: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}): SpanEvent {
  return Object.freeze({
    id: spanEventIdFor(input),
    name: input.name,
    timestamp: input.timestamp,
    ...(input.attributes !== undefined
      ? { attributes: Object.freeze({ ...input.attributes }) }
      : {}),
  });
}

/** Return a deep, detached copy of a span (never frozen). */
export function cloneSpan(span: Span): Span {
  return {
    id: span.id,
    traceId: span.traceId,
    ...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {}),
    kind: span.kind,
    name: span.name,
    startedAt: span.startedAt,
    ...(span.finishedAt !== undefined ? { finishedAt: span.finishedAt } : {}),
    ...(span.attributes !== undefined ? { attributes: { ...span.attributes } } : {}),
    events: span.events.map((event) => ({
      ...event,
      ...(event.attributes !== undefined ? { attributes: { ...event.attributes } } : {}),
    })),
    ...(span.error !== undefined ? { error: { ...span.error } } : {}),
    ...(span.durationMs !== undefined ? { durationMs: span.durationMs } : {}),
  };
}

/** Deep-freeze a span in place and return it (idempotent). */
export function freezeSpan(span: Span): Span {
  if (span.attributes !== undefined) Object.freeze(span.attributes);
  for (const event of span.events) {
    if (event.attributes !== undefined) Object.freeze(event.attributes);
    Object.freeze(event);
  }
  Object.freeze(span.events);
  if (span.error !== undefined) Object.freeze(span.error);
  return Object.freeze(span);
}

/** Stable hash of a span's identity. */
export function hashSpan(span: Span): string {
  return hashString(`${span.traceId}:${span.id}:${span.name}`);
}

/** Aggregate statistics over a set of spans. */
export interface TraceStatistics {
  readonly totalSpans: number;
  readonly openSpans: number;
  readonly finishedSpans: number;
  readonly erroredSpans: number;
  readonly byKind: Readonly<Record<SpanKind, number>>;
  readonly averageDurationMs?: number;
  readonly maxDurationMs?: number;
}

/** Compact summary of a trace. */
export interface TraceSummary {
  readonly traceId: string;
  readonly rootSpanId: string;
  readonly spanCount: number;
  readonly openCount: number;
  readonly erroredCount: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly kinds: readonly SpanKind[];
}

/** Point-in-time snapshot of a trace store. */
export interface TraceSnapshot {
  readonly at: string;
  readonly traces: readonly Trace[];
  readonly spans: readonly Span[];
  readonly statistics: TraceStatistics;
  readonly summaries: readonly TraceSummary[];
}

/** Options accepted by the {@link TraceStore} constructor. */
export interface TraceStoreOptions {
  readonly spans?: readonly Span[];
  readonly maxSpans?: number;
}

/** Aggregate span statistics. */
export function traceStatistics(spans: readonly Span[]): TraceStatistics {
  const byKind: Record<SpanKind, number> = {
    root: 0,
    api: 0,
    worker: 0,
    workflow: 0,
    job: 0,
    action: 0,
    digest: 0,
    memory: 0,
    conversation: 0,
    context: 0,
    planner: 0,
    tool: 0,
    database: 0,
    persistence: 0,
    queue: 0,
    llm: 0,
    event: 0,
    notification: 0,
  };
  let openSpans = 0;
  let finishedSpans = 0;
  let erroredSpans = 0;
  const durations: number[] = [];
  for (const span of spans) {
    byKind[span.kind] += 1;
    if (span.finishedAt === undefined) {
      openSpans += 1;
    } else {
      finishedSpans += 1;
      if (span.durationMs !== undefined) durations.push(span.durationMs);
    }
    if (span.error !== undefined) erroredSpans += 1;
  }
  const sorted = [...durations].sort((a, b) => a - b);
  return Object.freeze({
    totalSpans: spans.length,
    openSpans,
    finishedSpans,
    erroredSpans,
    byKind: Object.freeze(byKind),
    ...(durations.length > 0
      ? {
          averageDurationMs:
            durations.reduce((total, value) => total + value, 0) / durations.length,
          maxDurationMs: sorted[sorted.length - 1],
        }
      : {}),
  });
}

/** Group spans into traces keyed by trace id (root first, then by start). */
export function tracesFromSpans(spans: readonly Span[]): readonly Trace[] {
  const byTrace = new Map<string, Span[]>();
  for (const span of spans) {
    const bucket = byTrace.get(span.traceId);
    if (bucket === undefined) {
      byTrace.set(span.traceId, [span]);
    } else {
      bucket.push(span);
    }
  }
  const ordered = [...byTrace.entries()].sort(([left], [right]) => (left < right ? -1 : 1));
  return Object.freeze(
    ordered.map(([traceId, traceSpans]) => {
      const roots = traceSpans.filter((span) => span.parentSpanId === undefined);
      const rootSpan = roots.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))[0];
      return Object.freeze({
        traceId,
        rootSpanId: rootSpan?.id ?? "",
        spans: Object.freeze(
          [...traceSpans].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1)).map(cloneSpan),
        ),
      });
    }),
  );
}

/** Compact summaries of every trace. */
export function traceSummaries(spans: readonly Span[]): readonly TraceSummary[] {
  return tracesFromSpans(spans).map((trace) => {
    const started = trace.spans
      .map((span) => span.startedAt)
      .sort((a, b) => (a < b ? -1 : 1))[0];
    const finished = trace.spans
      .map((span) => span.finishedAt)
      .filter((value): value is string => value !== undefined)
      .sort((a, b) => (a < b ? -1 : 1))
      .reverse()[0];
    return Object.freeze({
      traceId: trace.traceId,
      rootSpanId: trace.rootSpanId,
      spanCount: trace.spans.length,
      openCount: trace.spans.filter((span) => span.finishedAt === undefined).length,
      erroredCount: trace.spans.filter((span) => span.error !== undefined).length,
      ...(started !== undefined ? { startedAt: started } : {}),
      ...(finished !== undefined ? { finishedAt: finished } : {}),
      kinds: Object.freeze(
        [...new Set(trace.spans.map((span) => span.kind))].sort(
          (a, b) => SPAN_KINDS.indexOf(a) - SPAN_KINDS.indexOf(b),
        ),
      ),
    });
  });
}

/**
 * An immutable trace store. Successor-based: `start`/`finish`/`addEvent`
 * return new stores; the receiver is never mutated.
 */
export class TraceStore {
  readonly spans: readonly Span[];

  private readonly maxSpans: number | undefined;

  constructor(options: TraceStoreOptions = {}) {
    this.spans = Object.freeze([...(options.spans ?? [])].map(cloneSpan));
    this.maxSpans = options.maxSpans;
  }

  /** Build a successor store from partial state. */
  private next(spans: readonly Span[]): TraceStore {
    return new TraceStore({ spans, maxSpans: this.maxSpans });
  }

  /** The number of retained spans. */
  count(): number {
    return this.spans.length;
  }

  /** Detached copies of every retained span. */
  list(): Span[] {
    return this.spans.map(cloneSpan);
  }

  /** The span with `spanId`, or `undefined`. */
  find(spanId: string): Span | undefined {
    const span = this.spans.find((candidate) => candidate.id === spanId);
    return span === undefined ? undefined : cloneSpan(span);
  }

  /** Open spans (not yet finished). */
  open(): Span[] {
    return this.spans.filter((span) => span.finishedAt === undefined).map(cloneSpan);
  }

  /** Spans belonging to `traceId`. */
  forTrace(traceId: string): Span[] {
    return this.spans.filter((span) => span.traceId === traceId).map(cloneSpan);
  }

  /** Open a new span and return the successor store. */
  start(input: StartSpanInput): { store: TraceStore; span: Span } {
    const span = createSpan({
      traceId: input.parentSpanId !== undefined ? this.traceOf(input.parentSpanId) : newTraceId(input),
      parentSpanId: input.parentSpanId,
      kind: input.kind,
      name: input.name,
      startedAt: input.startedAt,
      attributes: input.attributes,
    });
    let spans = [...this.spans, span];
    if (this.maxSpans !== undefined && spans.length > this.maxSpans) {
      spans = spans.slice(spans.length - this.maxSpans);
    }
    return { store: this.next(spans), span: cloneSpan(span) };
  }

  /** Close an open span with an optional error; returns the successor store. */
  finish(
    spanId: string,
    finishedAt: string,
    options: { error?: Readonly<{ code: string; message: string }> } = {},
  ): { store: TraceStore; span?: Span } {
    const existing = this.spans.find((span) => span.id === spanId);
    if (existing === undefined) return { store: this };
    const durationMs = Math.max(
      0,
      Date.parse(finishedAt) - Date.parse(existing.startedAt),
    );
    const finished: Span = Object.freeze({
      ...existing,
      finishedAt,
      ...(options.error !== undefined ? { error: Object.freeze({ ...options.error }) } : {}),
      durationMs,
      events: Object.freeze(existing.events.map((event) => ({ ...event }))),
    });
    const spans = this.spans.map((span) => (span.id === spanId ? finished : span));
    return { store: this.next(spans), span: cloneSpan(finished) };
  }

  /** Attach an event to a span; returns the successor store. */
  addEvent(
    spanId: string,
    name: string,
    timestamp: string,
    attributes?: Readonly<Record<string, unknown>>,
  ): { store: TraceStore; event?: SpanEvent } {
    const existing = this.spans.find((span) => span.id === spanId);
    if (existing === undefined) return { store: this };
    const event = createSpanEvent({ spanId, name, timestamp, attributes });
    const spans = this.spans.map((span) =>
      span.id === spanId
        ? Object.freeze({ ...span, events: Object.freeze([...span.events, event]) })
        : span,
    );
    return { store: this.next(spans), event };
  }

  /** Aggregate statistics over all retained spans. */
  statistics(): TraceStatistics {
    return traceStatistics(this.spans);
  }

  /** Grouped traces over all retained spans. */
  traces(): readonly Trace[] {
    return tracesFromSpans(this.spans);
  }

  /** Compact summaries of every trace. */
  summaries(): readonly TraceSummary[] {
    return traceSummaries(this.spans);
  }

  /** Point-in-time snapshot at `at`. */
  snapshot(at: string): TraceSnapshot {
    return Object.freeze({
      at,
      traces: this.traces(),
      spans: this.list(),
      statistics: this.statistics(),
      summaries: this.summaries(),
    });
  }

  /** The trace id a span belongs to, or a new root id. */
  private traceOf(spanId: string): string {
    const span = this.spans.find((candidate) => candidate.id === spanId);
    if (span === undefined) {
      throw new Error(`Cannot start a child of unknown span "${spanId}"`);
    }
    return span.traceId;
  }
}

/** Deterministic root trace id for a span without a parent. */
function newTraceId(input: StartSpanInput): string {
  return `trace-${hashString(`${input.kind}:${input.name}:${input.startedAt}`)}`;
}

/** Build a fresh trace store (dependency-injected). */
export function createTraceStore(options: TraceStoreOptions = {}): TraceStore {
  return new TraceStore(options);
}

/** Build a root trace and store from a single root span. */
export function createRootTrace(input: {
  readonly kind: SpanKind;
  readonly name: string;
  readonly startedAt: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}): { store: TraceStore; trace: Trace; span: Span } {
  const started = createTraceStore().start({
    kind: input.kind,
    name: input.name,
    startedAt: input.startedAt,
    attributes: input.attributes,
  });
  const traceId = started.span.traceId;
  return {
    store: started.store,
    trace: Object.freeze({
      traceId,
      rootSpanId: started.span.id,
      spans: Object.freeze([cloneSpan(started.span)]),
    }),
    span: cloneSpan(started.span),
  };
}

/** Build a span reference for linking. */
export function spanReference(span: Span): SpanReference {
  return Object.freeze({
    traceId: span.traceId,
    spanId: span.id,
    kind: span.kind,
    name: span.name,
  });
}
