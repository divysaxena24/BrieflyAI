/**
 * Observability & Monitoring — health monitoring (Phase 6C STEP 6).
 *
 * Immutable health checks over every engine domain: database, workers,
 * workflow engine, persistence, memory, conversation, context, action,
 * digest, tool registry, API, event bus and the monitoring engine itself.
 *
 * A `HealthRegistry` is successor-based: `check()` returns a new registry
 * with a `HealthEntry`; `runAll()` evaluates every registered probe into a
 * deterministic report. Checks are dependency-injected probes — nothing is
 * instantiated here.
 */

import { hashString } from "@/lib/hash";

/** The component whose health is measured. */
export type HealthComponent =
  | "database"
  | "workers"
  | "workflow_engine"
  | "persistence"
  | "memory_engine"
  | "conversation_engine"
  | "context_engine"
  | "action_engine"
  | "digest_engine"
  | "tool_registry"
  | "api"
  | "event_bus"
  | "monitoring_engine"
  | "notification_engine";

/** Every health component in a stable canonical order. */
export const HEALTH_COMPONENTS: readonly HealthComponent[] = Object.freeze([
  "database",
  "workers",
  "workflow_engine",
  "persistence",
  "memory_engine",
  "conversation_engine",
  "context_engine",
  "action_engine",
  "digest_engine",
  "tool_registry",
  "api",
  "event_bus",
  "monitoring_engine",
  "notification_engine",
]);

/** The status of a health check. */
export type HealthStatus = "healthy" | "warning" | "critical" | "unavailable";

/** Every health status in severity order. */
export const HEALTH_STATUSES: readonly HealthStatus[] = Object.freeze([
  "healthy",
  "warning",
  "critical",
  "unavailable",
]);

/** A single immutable health check result. */
export interface HealthEntry {
  /** Stable id: `health-<hash(component:timestamp)>`. */
  readonly id: string;
  readonly component: HealthComponent;
  readonly status: HealthStatus;
  /** ISO-8601 UTC timestamp (caller-supplied). */
  readonly timestamp: string;
  readonly message: string;
  /** Measured latency through an injected clock, when available. */
  readonly durationMs?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** A registered probe for a component. */
export interface HealthProbe {
  readonly component: HealthComponent;
  /** Pure (possibly async) check; never throws — see {@link HealthRegistry.check}. */
  readonly run: () => Promise<HealthEntry>;
}

/** Aggregate statistics over a set of health entries. */
export interface HealthStatistics {
  readonly total: number;
  readonly byStatus: Readonly<Record<HealthStatus, number>>;
  readonly healthyCount: number;
  readonly warningCount: number;
  readonly criticalCount: number;
  readonly unavailableCount: number;
}

/** Compact summary of a health report. */
export interface HealthSummary {
  readonly overall: HealthStatus;
  readonly total: number;
  readonly healthy: number;
  readonly warning: number;
  readonly critical: number;
  readonly unavailable: number;
}

/** A full health report at a point in time. */
export interface HealthReport {
  readonly at: string;
  readonly entries: readonly HealthEntry[];
  readonly summary: HealthSummary;
  readonly statistics: HealthStatistics;
}

/** Point-in-time snapshot of a health registry. */
export interface HealthSnapshot {
  readonly at: string;
  readonly report: HealthReport;
}

/** Deterministic id for a health entry. */
export function healthEntryIdFor(input: {
  readonly component: HealthComponent;
  readonly timestamp: string;
}): string {
  return `health-${hashString(`${input.component}:${input.timestamp}`)}`;
}

/** Build a health entry (deep-frozen). */
export function createHealthEntry(input: {
  readonly component: HealthComponent;
  readonly status: HealthStatus;
  readonly timestamp: string;
  readonly message: string;
  readonly durationMs?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}): HealthEntry {
  return Object.freeze({
    id: healthEntryIdFor(input),
    component: input.component,
    status: input.status,
    timestamp: input.timestamp,
    message: input.message,
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.details !== undefined ? { details: Object.freeze({ ...input.details }) } : {}),
  });
}

/** Return a deep, detached copy of an entry (never frozen). */
export function cloneHealthEntry(entry: HealthEntry): HealthEntry {
  return {
    id: entry.id,
    component: entry.component,
    status: entry.status,
    timestamp: entry.timestamp,
    message: entry.message,
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
    ...(entry.details !== undefined ? { details: { ...entry.details } } : {}),
  };
}

/** Aggregate statistics over a set of health entries. */
export function healthStatistics(entries: readonly HealthEntry[]): HealthStatistics {
  const byStatus: Record<HealthStatus, number> = {
    healthy: 0,
    warning: 0,
    critical: 0,
    unavailable: 0,
  };
  for (const entry of entries) {
    byStatus[entry.status] += 1;
  }
  return Object.freeze({
    total: entries.length,
    byStatus: Object.freeze(byStatus),
    healthyCount: byStatus.healthy,
    warningCount: byStatus.warning,
    criticalCount: byStatus.critical,
    unavailableCount: byStatus.unavailable,
  });
}

/** The worst status among entries (unavailable > critical > warning > healthy). */
export function worstStatus(entries: readonly HealthEntry[]): HealthStatus {
  let worst: HealthStatus = "healthy";
  for (const entry of entries) {
    const order = (status: HealthStatus): number => HEALTH_STATUSES.indexOf(status);
    if (order(entry.status) > order(worst)) worst = entry.status;
  }
  return worst;
}

/** Compact summary of a set of entries. */
export function healthSummary(entries: readonly HealthEntry[]): HealthSummary {
  const stats = healthStatistics(entries);
  return Object.freeze({
    overall: worstStatus(entries),
    total: stats.total,
    healthy: stats.healthyCount,
    warning: stats.warningCount,
    critical: stats.criticalCount,
    unavailable: stats.unavailableCount,
  });
}

/** Build a full health report at `at`. */
export function buildHealthReport(
  at: string,
  entries: readonly HealthEntry[],
): HealthReport {
  return Object.freeze({
    at,
    entries: Object.freeze(entries.map(cloneHealthEntry)),
    summary: healthSummary(entries),
    statistics: healthStatistics(entries),
  });
}

/** Options accepted by the {@link HealthRegistry} constructor. */
export interface HealthRegistryOptions {
  readonly probes?: readonly HealthProbe[];
  readonly history?: readonly HealthEntry[];
}

/**
 * An immutable health registry. `check()` evaluates a probe (isolating
 * failures into an `unavailable` entry) and returns a successor registry.
 * `runAll()` evaluates every probe at `at` deterministically.
 */
export class HealthRegistry {
  readonly probes: readonly HealthProbe[];
  readonly history: readonly HealthEntry[];

  constructor(options: HealthRegistryOptions = {}) {
    this.probes = Object.freeze([...(options.probes ?? [])]);
    this.history = Object.freeze([...(options.history ?? [])].map(cloneHealthEntry));
  }

  /** Build a successor registry from partial state. */
  private next(partial: {
    probes: readonly HealthProbe[];
    history: readonly HealthEntry[];
  }): HealthRegistry {
    return new HealthRegistry(partial);
  }

  /** Register a probe; returns the successor registry. */
  register(probe: HealthProbe): HealthRegistry {
    if (this.hasProbe(probe.component)) {
      throw new Error(`Health registry already contains "${probe.component}"`);
    }
    return this.next({ probes: [...this.probes, probe], history: this.history });
  }

  /** Whether a probe for `component` is registered. */
  hasProbe(component: HealthComponent): boolean {
    return this.probes.some((probe) => probe.component === component);
  }

  /** The registered probe for `component`, or `undefined`. */
  probe(component: HealthComponent): HealthProbe | undefined {
    return this.probes.find((candidate) => candidate.component === component);
  }

  /** The number of registered probes. */
  count(): number {
    return this.probes.length;
  }

  /** Snapshot of every registered probe, in registration order. */
  listProbes(): readonly HealthComponent[] {
    return this.probes.map((probe) => probe.component);
  }

  /**
   * Evaluate the probe for `component` at `timestamp`. A throwing probe is
   * isolated into an `unavailable` entry — the caller is never failed.
   */
  async check(
    component: HealthComponent,
    timestamp: string,
    clockMs?: () => number,
  ): Promise<{ registry: HealthRegistry; entry: HealthEntry }> {
    const probe = this.probe(component);
    if (probe === undefined) {
      const entry = createHealthEntry({
        component,
        status: "unavailable",
        timestamp,
        message: `No health probe registered for "${component}"`,
      });
      return { registry: this.next({ probes: this.probes, history: [...this.history, entry] }), entry };
    }
    const started = clockMs?.() ?? 0;
    try {
      const entry = await probe.run();
      const stamped = createHealthEntry({
        component: entry.component,
        status: entry.status,
        timestamp,
        message: entry.message,
        ...(clockMs !== undefined ? { durationMs: Math.max(0, clockMs() - started) } : {}),
        ...(entry.details !== undefined ? { details: entry.details } : {}),
      });
      return {
        registry: this.next({ probes: this.probes, history: [...this.history, stamped] }),
        entry: cloneHealthEntry(stamped),
      };
    } catch (err) {
      const entry = createHealthEntry({
        component,
        status: "unavailable",
        timestamp,
        message: err instanceof Error ? err.message : String(err),
      });
      return { registry: this.next({ probes: this.probes, history: [...this.history, entry] }), entry };
    }
  }

  /**
   * Evaluate every registered probe at `timestamp` in registration order
   * (sequential, deterministic). Returns the successor registry and report.
   */
  async runAll(
    timestamp: string,
    clockMs?: () => number,
  ): Promise<{ registry: HealthRegistry; report: HealthReport }> {
    let registry = new HealthRegistry({ probes: this.probes, history: this.history });
    const entries: HealthEntry[] = [];
    for (const probe of this.probes) {
      const { registry: next, entry } = await registry.check(probe.component, timestamp, clockMs);
      registry = next;
      entries.push(entry);
    }
    return { registry, report: buildHealthReport(timestamp, entries) };
  }

  /** The most recent entry for `component`, or `undefined`. */
  latest(component: HealthComponent): HealthEntry | undefined {
    let found: HealthEntry | undefined;
    for (const entry of this.history) {
      if (entry.component === component) found = entry;
    }
    return found === undefined ? undefined : cloneHealthEntry(found);
  }

  /** Every entry for `component`, oldest first. */
  forComponent(component: HealthComponent): HealthEntry[] {
    return this.history.filter((entry) => entry.component === component).map(cloneHealthEntry);
  }

  /** The full report over the most recent entry of every probed component. */
  report(timestamp: string): HealthReport {
    const latestByComponent = new Map<HealthComponent, HealthEntry>();
    for (const entry of this.history) {
      latestByComponent.set(entry.component, entry);
    }
    return buildHealthReport(timestamp, [...latestByComponent.values()]);
  }

  /** Aggregate statistics over the whole history. */
  statistics(): HealthStatistics {
    return healthStatistics(this.history);
  }

  /** Point-in-time snapshot at `at`. */
  snapshot(at: string): HealthSnapshot {
    return Object.freeze({
      at,
      report: this.report(at),
    });
  }
}

/** Build a fresh health registry. */
export function createHealthRegistry(options: HealthRegistryOptions = {}): HealthRegistry {
  return new HealthRegistry(options);
}

/** Build a simple healthy probe for `component`. */
export function healthyProbe(
  component: HealthComponent,
  message = `${component} is healthy`,
): HealthProbe {
  return {
    component,
    run: async () => createHealthEntry({ component, status: "healthy", timestamp: "", message }),
  };
}

/** Build a simple unhealthy probe for `component`. */
export function unhealthyProbe(
  component: HealthComponent,
  message: string,
  status: Exclude<HealthStatus, "healthy"> = "critical",
): HealthProbe {
  return {
    component,
    run: async () => createHealthEntry({ component, status, timestamp: "", message }),
  };
}

/** The overall status of a report (worst entry). */
export function overallStatus(report: HealthReport): HealthStatus {
  return report.summary.overall;
}
