/**
 * Application Event Bus — the bus (Phase 5J STEP 5).
 *
 * `EventBus` is an immutable listener registry with an async, failure-isolated
 * `emit`:
 *
 * - **Immutable**: `subscribe` / `unsubscribe` return a *new* bus (successor
 *   pattern); the receiver is never mutated.
 * - **Async listeners**: listeners may return promises; `emit` awaits every
 *   listener before resolving.
 * - **Failure isolation**: a throwing/rejecting listener never fails the
 *   caller or the other listeners — it is recorded in the emit summary.
 * - **No duplication**: an event is delivered exactly once to each listener
 *   registered for its kind, in registration order.
 * - **No global mutable state**: buses are plain objects — the application
 *   wires its own instance.
 *
 * `emit` never throws: every outcome is a structured `EmitSummary`.
 *
 * Listener ids are deterministic within a bus lineage: a plain subscribe
 * counter is threaded through successors, so `listener-<n>` is stable and
 * never reused while the listener is registered.
 */

import type { AppEvent, AppEventType } from "./types";

/** A listener: receives the immutable event; may be async. */
export type AppEventListener = (event: AppEvent) => void | Promise<void>;

/** A registered listener entry. */
export interface ListenerEntry {
  /** Stable subscription id (deterministic per bus lineage). */
  readonly id: string;
  readonly type: AppEventType;
  readonly listener: AppEventListener;
}

/** Per-listener outcome of an emit. */
export interface ListenerOutcome {
  readonly listenerId: string;
  /** True when the listener ran without throwing. */
  readonly ok: boolean;
  /** The listener's error message when it failed (isolated). */
  readonly error?: string;
}

/** Aggregated outcome of an emit. */
export interface EmitSummary {
  readonly event: AppEvent;
  /** One outcome per delivered listener, in delivery order. */
  readonly outcomes: readonly ListenerOutcome[];
  readonly total: number;
  readonly delivered: number;
  readonly failed: number;
}

/** Build an emit summary from outcomes. */
function summarize(event: AppEvent, outcomes: readonly ListenerOutcome[]): EmitSummary {
  return {
    event,
    outcomes,
    total: outcomes.length,
    delivered: outcomes.filter((outcome) => outcome.ok).length,
    failed: outcomes.filter((outcome) => !outcome.ok).length,
  };
}

/**
 * Immutable application event bus.
 *
 * `subscribe` / `unsubscribe` never mutate the receiver; `emit` delivers to a
 * frozen snapshot of the listeners registered at call time.
 */
export class EventBus {
  /** Every registered listener, in subscription order (frozen snapshot). */
  private readonly entries: readonly ListenerEntry[];

  /** Monotonic subscribe counter threaded through successors. */
  private readonly sequence: number;

  constructor(entries: readonly ListenerEntry[] = [], sequence = 0) {
    this.entries = Object.freeze([...entries]);
    this.sequence = sequence;
  }

  /**
   * Return a new bus with `listener` subscribed to `type`. The listener id is
   * deterministic within this bus lineage. Never mutates `this`.
   */
  subscribe(type: AppEventType, listener: AppEventListener): { bus: EventBus; id: string } {
    const id = `listener-${this.sequence}`;
    const entry: ListenerEntry = { id, type, listener };
    return { bus: new EventBus([...this.entries, entry], this.sequence + 1), id };
  }

  /**
   * Return a new bus without the listener `id` (no-op when absent). The
   * subscribe counter is preserved. Never mutates `this`.
   */
  unsubscribe(id: string): EventBus {
    if (!this.hasListener(id)) return this;
    return new EventBus(
      this.entries.filter((entry) => entry.id !== id),
      this.sequence,
    );
  }

  /** Whether a listener with `id` is registered. */
  hasListener(id: string): boolean {
    return this.entries.some((entry) => entry.id === id);
  }

  /** Number of listeners registered for `type`. */
  subscriberCount(type: AppEventType): number {
    return this.entries.filter((entry) => entry.type === type).length;
  }

  /** Snapshot of every registered listener, in subscription order. */
  listenersSnapshot(): readonly ListenerEntry[] {
    return [...this.entries];
  }

  /**
   * Deliver `event` to every listener registered for its kind, in
   * subscription order. Async listeners are awaited; a failing listener is
   * isolated and reported. Never throws — returns a structured summary.
   */
  async emit(event: AppEvent): Promise<EmitSummary> {
    const targets = this.entries.filter((entry) => entry.type === event.type);
    const outcomes: ListenerOutcome[] = [];
    for (const entry of targets) {
      try {
        await entry.listener(event);
        outcomes.push({ listenerId: entry.id, ok: true });
      } catch (err) {
        outcomes.push({
          listenerId: entry.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return summarize(event, outcomes);
  }
}
