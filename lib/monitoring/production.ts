/**
 * Observability & Monitoring — production composition (Phase 6C STEP 9).
 *
 * `MonitoringEngine` is the composition root of the monitoring layer. It
 * wires the immutable collectors:
 *
 * ```text
 * Logger (structured logs)      → MetricCollector (counts/latency/rates)
 * TraceStore (spans/traces)     → ProfileCollector (stage durations)
 * HealthRegistry (probes)       → AlertRegistry (rules/alerts)
 * AuditStore (audit trail)
 * ```
 *
 * - `createProductionMonitoringEngine()` is a pure factory: it only wires
 *   the graph (optionally seeded with injected collectors); nothing runs
 *   during construction.
 * - `getProductionMonitoringEngine()` returns the application's single
 *   engine instance (module-level singleton).
 *
 * The engine exposes thin read/write facades over each collector; it never
 * reimplements their logic.
 */

import { Logger, type LogCorrelation, type LogEntry, type LogLevel, type LogScope } from "./logger";
import {
  MetricCollector,
  type CreateMetricSampleInput,
  type MetricDomain,
  type MetricReport,
  type MetricSample,
} from "./metrics";
import { TraceStore, type Span, type SpanKind } from "./tracing";
import {
  ProfileCollector,
  type CreateProfileSampleInput,
  type ProfileStage,
} from "./profiler";
import {
  HealthRegistry,
  type HealthComponent,
  type HealthEntry,
  type HealthProbe,
  type HealthReport,
} from "./health";
import {
  AlertRegistry,
  type Alert,
  type AlertRuleType,
  type AlertSeverity,
  type CreateAlertInput,
  type CreateAlertRuleInput,
} from "./alerts";
import {
  AuditStore,
  type AuditAction,
  type AuditEntry,
  type CreateAuditEntryInput,
} from "./audit";

/** Options accepted by the {@link MonitoringEngine} constructor. */
export interface MonitoringEngineOptions {
  /** Logger (dependency injection); fresh by default. */
  readonly logger?: Logger;
  /** Metric collector (dependency injection); fresh by default. */
  readonly metrics?: MetricCollector;
  /** Trace store (dependency injection); fresh by default. */
  readonly traces?: TraceStore;
  /** Profile collector (dependency injection); fresh by default. */
  readonly profiler?: ProfileCollector;
  /** Health registry (dependency injection); fresh by default. */
  readonly health?: HealthRegistry;
  /** Alert registry (dependency injection); fresh by default. */
  readonly alerts?: AlertRegistry;
  /** Audit store (dependency injection); fresh by default. */
  readonly audit?: AuditStore;
}

/**
 * The monitoring engine — the application composition root. Owns the seven
 * immutable collectors and re-exposes their read/write facades. The
 * collectors are *replaced* via successor construction on every write, so
 * the engine is internally mutable-by-replacement (matching the production
 * composition roots of the earlier phases) while every model stays
 * immutable.
 */
export class MonitoringEngine {
  private _logger: Logger;
  private _metrics: MetricCollector;
  private _traces: TraceStore;
  private _profiler: ProfileCollector;
  private _health: HealthRegistry;
  private _alerts: AlertRegistry;
  private _audit: AuditStore;

  constructor(options: MonitoringEngineOptions = {}) {
    this._logger = options.logger ?? new Logger();
    this._metrics = options.metrics ?? new MetricCollector();
    this._traces = options.traces ?? new TraceStore();
    this._profiler = options.profiler ?? new ProfileCollector();
    this._health = options.health ?? new HealthRegistry();
    this._alerts = options.alerts ?? new AlertRegistry();
    this._audit = options.audit ?? new AuditStore();
  }

  // ── Read-only facades ──────────────────────────────────────────

  /** The current logger (readonly view). */
  get logger(): Logger {
    return this._logger;
  }

  /** The current metric collector (readonly view). */
  get metrics(): MetricCollector {
    return this._metrics;
  }

  /** The current trace store (readonly view). */
  get traces(): TraceStore {
    return this._traces;
  }

  /** The current profile collector (readonly view). */
  get profiler(): ProfileCollector {
    return this._profiler;
  }

  /** The current health registry (readonly view). */
  get health(): HealthRegistry {
    return this._health;
  }

  /** The current alert registry (readonly view). */
  get alerts(): AlertRegistry {
    return this._alerts;
  }

  /** The current audit store (readonly view). */
  get audit(): AuditStore {
    return this._audit;
  }

  // ── Logging facade ─────────────────────────────────────────────

  /** Record a structured log entry; updates the engine's logger. */
  log(
    level: LogLevel,
    message: string,
    timestamp: string,
    options: { scope?: LogScope; correlation?: LogCorrelation } = {},
  ): { engine: MonitoringEngine; entry?: LogEntry } {
    const { logger, entry } = this._logger.log(level, message, timestamp, options);
    this._logger = logger;
    return { engine: this, entry };
  }

  /** Record an info log entry. */
  info(
    message: string,
    timestamp: string,
    options: { scope?: LogScope; correlation?: LogCorrelation } = {},
  ): { engine: MonitoringEngine; entry?: LogEntry } {
    return this.log("info", message, timestamp, options);
  }

  /** Record an error log entry. */
  error(
    message: string,
    timestamp: string,
    options: { scope?: LogScope; correlation?: LogCorrelation } = {},
  ): { engine: MonitoringEngine; entry?: LogEntry } {
    return this.log("error", message, timestamp, options);
  }

  // ── Metrics facade ─────────────────────────────────────────────

  /** Record a metric sample; updates the engine's collector. */
  metric(input: CreateMetricSampleInput): { engine: MonitoringEngine; sample: MetricSample } {
    const { collector, sample } = this._metrics.record(input);
    this._metrics = collector;
    return { engine: this, sample };
  }

  /** Record a counter increment. */
  increment(
    domain: MetricDomain,
    name: string,
    timestamp: string,
    by = 1,
    entityId?: string,
  ): { engine: MonitoringEngine; sample: MetricSample } {
    const { collector, sample } = this._metrics.increment(domain, name, timestamp, by, entityId);
    this._metrics = collector;
    return { engine: this, sample };
  }

  /** Record a latency sample. */
  latency(
    domain: MetricDomain,
    name: string,
    durationMs: number,
    timestamp: string,
    entityId?: string,
  ): { engine: MonitoringEngine; sample: MetricSample } {
    const { collector, sample } = this._metrics.latency(domain, name, durationMs, timestamp, entityId);
    this._metrics = collector;
    return { engine: this, sample };
  }

  /** A metrics report at `at`. */
  metricsReport(at: string): MetricReport {
    return this._metrics.report(at);
  }

  // ── Tracing facade ─────────────────────────────────────────────

  /** Open a span; updates the engine's trace store. */
  startSpan(input: {
    readonly parentSpanId?: string;
    readonly kind: SpanKind;
    readonly name: string;
    readonly startedAt: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
  }): { engine: MonitoringEngine; span: Span } {
    const { store, span } = this._traces.start(input);
    this._traces = store;
    return { engine: this, span };
  }

  /** Close a span; updates the engine's trace store. */
  finishSpan(
    spanId: string,
    finishedAt: string,
    options: { error?: Readonly<{ code: string; message: string }> } = {},
  ): { engine: MonitoringEngine; span?: Span } {
    const { store, span } = this._traces.finish(spanId, finishedAt, options);
    this._traces = store;
    return { engine: this, span };
  }

  // ── Profiler facade ────────────────────────────────────────────

  /** Record a profile sample; updates the engine's collector. */
  profile(input: CreateProfileSampleInput): { engine: MonitoringEngine } {
    const { collector } = this._profiler.record(input);
    this._profiler = collector;
    return { engine: this };
  }

  /** Measure `work` through the injected clock and record a sample. */
  async measure<T>(
    input: {
      readonly stage: ProfileStage;
      readonly name: string;
      readonly startedAt: string;
      readonly clockMs: () => number;
    },
    work: () => Promise<T>,
  ): Promise<{ engine: MonitoringEngine; durationMs: number; result: T }> {
    const { collector, durationMs, result } = await this._profiler.measure(input, work);
    this._profiler = collector;
    return { engine: this, durationMs, result };
  }

  // ── Health facade ──────────────────────────────────────────────

  /** Register a health probe; updates the engine's registry. */
  registerHealthProbe(probe: HealthProbe): MonitoringEngine {
    this._health = this._health.register(probe);
    return this;
  }

  /** Run every registered health probe at `timestamp`. */
  async runHealthChecks(
    timestamp: string,
    clockMs?: () => number,
  ): Promise<{ engine: MonitoringEngine; report: HealthReport }> {
    const { registry, report } = await this._health.runAll(timestamp, clockMs);
    this._health = registry;
    return { engine: this, report };
  }

  /** The health report over the latest entry of every probed component. */
  healthReport(timestamp: string): HealthReport {
    return this._health.report(timestamp);
  }

  /** The latest health entry for `component`, or `undefined`. */
  healthOf(component: HealthComponent): HealthEntry | undefined {
    return this._health.latest(component);
  }

  // ── Alerts facade ──────────────────────────────────────────────

  /** Register an alert rule; updates the engine's registry. */
  registerAlertRule(input: CreateAlertRuleInput): MonitoringEngine {
    this._alerts = this._alerts.registerRule(input);
    return this;
  }

  /** Raise an alert; updates the engine's registry. */
  raiseAlert(input: CreateAlertInput): { engine: MonitoringEngine; alert: Alert } {
    const { registry, alert } = this._alerts.raise(input);
    this._alerts = registry;
    return { engine: this, alert };
  }

  /** Acknowledge an alert. */
  acknowledgeAlert(alertId: string, at: string, actor?: string): MonitoringEngine {
    const { registry } = this._alerts.acknowledge(alertId, at, actor);
    this._alerts = registry;
    return this;
  }

  /** Resolve an alert. */
  resolveAlert(alertId: string, at: string): MonitoringEngine {
    const { registry } = this._alerts.resolve(alertId, at);
    this._alerts = registry;
    return this;
  }

  /** Re-raise an alert (bumps retry count). */
  retryAlert(alertId: string, at: string): MonitoringEngine {
    const { registry } = this._alerts.retry(alertId, at);
    this._alerts = registry;
    return this;
  }

  /** Whether an alert rule for `type` is registered. */
  hasAlertRule(type: AlertRuleType): boolean {
    return this._alerts.rulesForType(type).length > 0;
  }

  // ── Audit facade ───────────────────────────────────────────────

  /** Record an audit entry; updates the engine's store. */
  auditRecord(input: CreateAuditEntryInput): { engine: MonitoringEngine; entry: AuditEntry } {
    const { store, entry } = this._audit.record(input);
    this._audit = store;
    return { engine: this, entry };
  }

  /** Entries for an audit action. */
  auditFor(action: AuditAction): readonly AuditEntry[] {
    return this._audit.forAction(action);
  }

  /** Aggregate audit statistics. */
  auditStatistics(): ReturnType<AuditStore["statistics"]> {
    return this._audit.statistics();
  }

  // ── Snapshot facade ────────────────────────────────────────────

  /** A combined point-in-time snapshot at `at`. */
  snapshot(at: string): MonitoringSnapshot {
    return Object.freeze({
      at,
      logs: this._logger.snapshot(at),
      metrics: this._metrics.snapshot(at),
      traces: this._traces.snapshot(at),
      profiler: this._profiler.snapshot(at),
      health: this._health.snapshot(at),
      alerts: this._alerts.snapshot(at),
      audit: this._audit.snapshot(at),
    });
  }
}

/** A combined point-in-time snapshot of every monitoring collector. */
export interface MonitoringSnapshot {
  readonly at: string;
  readonly logs: ReturnType<Logger["snapshot"]>;
  readonly metrics: ReturnType<MetricCollector["snapshot"]>;
  readonly traces: ReturnType<TraceStore["snapshot"]>;
  readonly profiler: ReturnType<ProfileCollector["snapshot"]>;
  readonly health: ReturnType<HealthRegistry["snapshot"]>;
  readonly alerts: ReturnType<AlertRegistry["snapshot"]>;
  readonly audit: ReturnType<AuditStore["snapshot"]>;
}

/**
 * Build a fresh production monitoring engine.
 *
 * Wires fresh immutable collectors; optional overrides seed the graph for
 * dependency injection. Pure — construction only; nothing runs.
 */
export function createProductionMonitoringEngine(
  options: MonitoringEngineOptions = {},
): MonitoringEngine {
  return new MonitoringEngine(options);
}

/**
 * The application's single production monitoring engine instance.
 * Created once at module load.
 */
const productionMonitoringEngine = createProductionMonitoringEngine();

/** Return the application's single production monitoring engine instance. */
export function getProductionMonitoringEngine(): MonitoringEngine {
  return productionMonitoringEngine;
}

/** Convenience: record a log entry through the production engine. */
export function log(
  level: LogLevel,
  message: string,
  timestamp: string,
  options: { scope?: LogScope; correlation?: LogCorrelation } = {},
): { engine: MonitoringEngine; entry?: LogEntry } {
  return getProductionMonitoringEngine().log(level, message, timestamp, options);
}

/** Convenience: record a metric sample through the production engine. */
export function recordMetric(input: CreateMetricSampleInput): {
  engine: MonitoringEngine;
  sample: MetricSample;
} {
  return getProductionMonitoringEngine().metric(input);
}

/** Convenience: raise an alert through the production engine. */
export function alert(input: CreateAlertInput): { engine: MonitoringEngine; alert: Alert } {
  return getProductionMonitoringEngine().raiseAlert(input);
}

/** Convenience: record an audit entry through the production engine. */
export function audit(input: CreateAuditEntryInput): {
  engine: MonitoringEngine;
  entry: AuditEntry;
} {
  return getProductionMonitoringEngine().auditRecord(input);
}

/** The default severity used for an alert rule type (re-export). */
export type { AlertSeverity };
