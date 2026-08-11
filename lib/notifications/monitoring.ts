/**
 * Notification & Delivery System — monitoring integration (Phase 6D STEP 9).
 *
 * A thin, dependency-injected bridge over the Phase 6C `MonitoringEngine`.
 * It reuses the production collectors (logger, metrics, tracing, profiler,
 * health, alerts, audit) to observe the notification pipeline — no
 * monitoring logic is reimplemented:
 *
 * - **Metrics**: `notification.*` samples on the `notifications` domain —
 *   delivery latency, retry counts, queue depth, failure rate, dead letters.
 * - **Spans**: notification dispatch spans (`kind: "notification"`).
 * - **Profiling**: delivery stage samples (`stage: "notification"`).
 * - **Health**: registers a `notification_engine` probe derived from the
 *   delivery engine's `NotificationHealth` (a pure projection at a
 *   caller-supplied `now` — no closures, no wall clock).
 * - **Alerts**: raises `notification_failure` alerts (rule ensured
 *   idempotently) on delivery failures / dead letters / queue overflow.
 * - **Audit**: records delivery lifecycle entries (resource
 *   `notification.<id>`, action `api_mutation`, success/failure outcome).
 * - **Logs**: structured entries under the `notifications` scope.
 *
 * Everything is deterministic; all timestamps and clock reads are injected
 * by the caller. The bridge holds no state of its own — every write
 * forwards to the engine's successor facades and returns the bridge.
 */

import { hashString } from "@/lib/hash";
import { createHealthEntry } from "@/lib/monitoring/health";
import { Logger } from "@/lib/monitoring/logger";
import { MonitoringEngine, type MonitoringSnapshot } from "@/lib/monitoring/production";
import type { CreateAlertInput } from "@/lib/monitoring/alerts";
import type { CreateAuditEntryInput } from "@/lib/monitoring/audit";
import type { CreateProfileSampleInput } from "@/lib/monitoring/profiler";
import type { LogCorrelation, LogScope } from "@/lib/monitoring/logger";
import type { NotificationChannelType, NotificationHealth } from "./types";

/** The metric domain of the notification layer (extended Phase 6C union). */
export const NOTIFICATION_METRIC_DOMAIN = "notifications" as const;

/** The profile stage of notification delivery (extended Phase 6C union). */
export const NOTIFICATION_PROFILE_STAGE = "notification" as const;

/** The span kind of notification dispatch (extended Phase 6C union). */
export const NOTIFICATION_SPAN_KIND = "notification" as const;

/** The health component of the notification engine (extended Phase 6C union). */
export const NOTIFICATION_HEALTH_COMPONENT = "notification_engine" as const;

/** The alert rule type raised on notification failures. */
export const NOTIFICATION_ALERT_TYPE = "notification_failure" as const;

/** The log scope of the notification layer. */
export const NOTIFICATION_LOG_SCOPE: LogScope = Object.freeze({ name: "notifications" });

/** Options accepted by the {@link NotificationMonitoringBridge} constructor. */
export interface NotificationMonitoringBridgeOptions {
  /** The monitoring engine (dependency injection); fresh by default. */
  readonly engine?: MonitoringEngine;
}

/** A delivery observation fed into the bridge. */
export interface NotificationDeliveryObservation {
  readonly notificationId: string;
  readonly ok: boolean;
  /** Delivery latency in milliseconds (injected clock). */
  readonly durationMs: number;
  readonly channel?: NotificationChannelType;
  readonly at: string;
}

/** Queue depth observation. */
export interface NotificationQueueDepthObservation {
  readonly at: string;
  readonly pending: number;
  readonly delayed: number;
  readonly retry: number;
  readonly deadLetter: number;
}

/** A failure observation (dead letter / terminal failure). */
export interface NotificationFailureObservation {
  readonly notificationId: string;
  readonly code: string;
  readonly message: string;
  readonly attempt: number;
  readonly at: string;
}

/** The alert rule id of the notification failure rule. */
export function notificationAlertRuleId(severity: CreateAlertInput["severity"]): string {
  return `alert-rule-${hashString(`${NOTIFICATION_ALERT_TYPE}:${severity}`)}`;
}

/**
 * The notifications → monitoring bridge. Every write forwards to the
 * wrapped engine and returns the bridge; reads delegate to the engine's
 * collectors. No notification-specific monitoring state lives here.
 */
export class NotificationMonitoringBridge {
  private _engine: MonitoringEngine;

  constructor(options: NotificationMonitoringBridgeOptions = {}) {
    // The wrapped engine's logger is scoped to "notifications" so every
    // entry through the engine's log facade lands on the notification
    // scope (the Logger applies its own scope on insertion).
    this._engine =
      options.engine ??
      new MonitoringEngine({ logger: new Logger({ scope: NOTIFICATION_LOG_SCOPE }) });
  }

  /** The current monitoring engine. */
  get engine(): MonitoringEngine {
    return this._engine;
  }

  /** Replace the wrapped engine (successor wiring). */
  withEngine(engine: MonitoringEngine): NotificationMonitoringBridge {
    this._engine = engine;
    return this;
  }

  // ── Logs ──────────────────────────────────────────────────────

  /** Record a structured log entry under the notifications scope. */
  log(
    level: "trace" | "debug" | "info" | "warn" | "error" | "fatal",
    message: string,
    timestamp: string,
    options: { correlation?: LogCorrelation; context?: Record<string, unknown> } = {},
  ): NotificationMonitoringBridge {
    this._engine = this._engine.log(level, message, timestamp, {
      ...(options.correlation !== undefined ? { correlation: options.correlation } : {}),
      ...(options.context !== undefined ? { context: options.context } : {}),
    }).engine;
    return this;
  }

  /** Convenience: record an info log. */
  info(message: string, timestamp: string): NotificationMonitoringBridge {
    return this.log("info", message, timestamp);
  }

  /** Convenience: record an error log. */
  error(message: string, timestamp: string): NotificationMonitoringBridge {
    return this.log("error", message, timestamp);
  }

  // ── Metrics ───────────────────────────────────────────────────

  /** Record a counter increment on the notifications domain. */
  increment(name: string, timestamp: string, by = 1, entityId?: string): NotificationMonitoringBridge {
    this._engine = this._engine.increment(
      NOTIFICATION_METRIC_DOMAIN,
      name,
      timestamp,
      by,
      entityId,
    ).engine;
    return this;
  }

  /** Record a latency sample on the notifications domain. */
  latency(name: string, durationMs: number, timestamp: string, entityId?: string): NotificationMonitoringBridge {
    this._engine = this._engine.latency(
      NOTIFICATION_METRIC_DOMAIN,
      name,
      durationMs,
      timestamp,
      entityId,
    ).engine;
    return this;
  }

  /** Record a gauge sample (queue depth / failure rate). */
  gauge(name: string, value: number, timestamp: string): NotificationMonitoringBridge {
    this._engine = this._engine.metric({
      domain: NOTIFICATION_METRIC_DOMAIN,
      name,
      kind: "gauge",
      value,
      timestamp,
    }).engine;
    return this;
  }

  /** Record a notification delivery observation (latency + outcome). */
  observeDelivery(observation: NotificationDeliveryObservation): NotificationMonitoringBridge {
    const { notificationId, ok, durationMs, at } = observation;
    this.latency("notification.delivery.latency", durationMs, at, notificationId);
    this.increment(
      ok ? "notification.delivered" : "notification.failed",
      at,
      1,
      notificationId,
    );
    return this;
  }

  /** Record a retry observation. */
  observeRetry(notificationId: string, attempt: number, at: string): NotificationMonitoringBridge {
    this.increment("notification.retried", at, 1, notificationId);
    this.gauge("notification.retry.attempt", attempt, at);
    return this;
  }

  /** Record a failure observation (dead letter / terminal). */
  observeFailure(observation: NotificationFailureObservation): NotificationMonitoringBridge {
    this.increment("notification.dead", observation.at, 1, observation.notificationId);
    this.log("warn", `Notification ${observation.notificationId} failed: ${observation.code}`, observation.at, {
      context: {
        notificationId: observation.notificationId,
        code: observation.code,
        attempt: observation.attempt,
      },
    });
    return this;
  }

  /** Record queue depth (gauges). */
  observeQueueDepth(observation: NotificationQueueDepthObservation): NotificationMonitoringBridge {
    const { at, pending, delayed, retry, deadLetter } = observation;
    this.gauge("notification.queue.pending", pending, at);
    this.gauge("notification.queue.delayed", delayed, at);
    this.gauge("notification.queue.retry", retry, at);
    this.gauge("notification.queue.deadLetter", deadLetter, at);
    this.gauge("notification.queue.total", pending + delayed + retry + deadLetter, at);
    return this;
  }

  /** Record the failure rate (0..1) at `at`. */
  observeFailureRate(rate: number, at: string): NotificationMonitoringBridge {
    this.gauge("notification.failure.rate", rate, at);
    return this;
  }

  // ── Tracing & profiling ───────────────────────────────────────

  /** Open a notification dispatch span. */
  startDispatchSpan(
    notificationId: string,
    startedAt: string,
    parentSpanId?: string,
  ): { bridge: NotificationMonitoringBridge; spanId: string } {
    const { engine, span } = this._engine.startSpan({
      kind: NOTIFICATION_SPAN_KIND,
      name: "notification.dispatch",
      startedAt,
      ...(parentSpanId !== undefined ? { parentSpanId } : {}),
      attributes: { notificationId },
    });
    this._engine = engine;
    return { bridge: this, spanId: span.id };
  }

  /** Close a notification dispatch span (with optional error). */
  finishDispatchSpan(
    spanId: string,
    finishedAt: string,
    error?: { code: string; message: string },
  ): NotificationMonitoringBridge {
    this._engine = this._engine.finishSpan(spanId, finishedAt, { error }).engine;
    return this;
  }

  /** Record a delivery profile sample. */
  profile(input: Omit<CreateProfileSampleInput, "stage">): NotificationMonitoringBridge {
    this._engine = this._engine.profile({
      stage: NOTIFICATION_PROFILE_STAGE,
      ...input,
    }).engine;
    return this;
  }

  // ── Health ────────────────────────────────────────────────────

  /**
   * Register a `notification_engine` health probe derived from a
   * caller-supplied `NotificationHealth` (a pure projection at `now` — no
   * closures, no wall clock). The probe's run is deterministic.
   */
  registerHealthProbe(now: string, health: NotificationHealth): NotificationMonitoringBridge {
    this._engine = this._engine.registerHealthProbe({
      component: NOTIFICATION_HEALTH_COMPONENT,
      run: async () =>
        createHealthEntry({
          component: NOTIFICATION_HEALTH_COMPONENT,
          status: mapNotificationHealthStatus(health),
          timestamp: now,
          message: health.message ?? "notification engine health",
        }),
    });
    return this;
  }

  // ── Alerts ────────────────────────────────────────────────────

  /** Raise a `notification_failure` alert (rule ensured idempotently). */
  raiseNotificationAlert(input: {
    readonly entityId: string;
    readonly key: string;
    readonly message: string;
    readonly createdAt: string;
    readonly severity?: CreateAlertInput["severity"];
  }): NotificationMonitoringBridge {
    const severity = input.severity ?? "warning";
    if (!this._engine.hasAlertRule(NOTIFICATION_ALERT_TYPE)) {
      this._engine = this._engine.registerAlertRule({
        type: NOTIFICATION_ALERT_TYPE,
        severity,
      });
    }
    this._engine = this._engine.raiseAlert({
      ruleId: notificationAlertRuleId(severity),
      type: NOTIFICATION_ALERT_TYPE,
      severity,
      entityId: input.entityId,
      key: input.key,
      message: input.message,
      createdAt: input.createdAt,
    }).engine;
    return this;
  }

  // ── Audit ─────────────────────────────────────────────────────

  /** Record a notification audit entry (action `api_mutation`). */
  audit(input: Omit<CreateAuditEntryInput, "action">): NotificationMonitoringBridge {
    this._engine = this._engine.auditRecord({
      action: "api_mutation",
      ...input,
    }).engine;
    return this;
  }

  // ── Reads (delegate to the engine) ────────────────────────────

  /** The notification delivery-latency series (deterministic order). */
  deliveryLatencySeries(): readonly { durationMs: number; at: string; notificationId?: string }[] {
    return this._engine.metrics
      .find(NOTIFICATION_METRIC_DOMAIN, "notification.delivery.latency")
      .map((sample) => ({
        durationMs: sample.value,
        at: sample.timestamp,
        ...(sample.entityId !== undefined ? { notificationId: sample.entityId } : {}),
      }));
  }

  /** Aggregated delivered/failed/retried/dead counts. */
  counts(): { delivered: number; failed: number; retried: number; dead: number } {
    const series = (name: string): number =>
      this._engine.metrics
        .find(NOTIFICATION_METRIC_DOMAIN, name)
        .reduce((total, sample) => total + sample.value, 0);
    return Object.freeze({
      delivered: series("notification.delivered"),
      failed: series("notification.failed"),
      retried: series("notification.retried"),
      dead: series("notification.dead"),
    });
  }

  /** The latest queue-depth gauge values. */
  queueDepth(): { pending: number; delayed: number; retry: number; deadLetter: number } {
    const gauge = (name: string): number => {
      const samples = this._engine.metrics.find(NOTIFICATION_METRIC_DOMAIN, name);
      const last = samples.length > 0 ? samples[samples.length - 1] : undefined;
      return last?.value ?? 0;
    };
    return Object.freeze({
      pending: gauge("notification.queue.pending"),
      delayed: gauge("notification.queue.delayed"),
      retry: gauge("notification.queue.retry"),
      deadLetter: gauge("notification.queue.deadLetter"),
    });
  }

  /** The latest failure-rate gauge value. */
  failureRate(): number {
    const samples = this._engine.metrics.find(NOTIFICATION_METRIC_DOMAIN, "notification.failure.rate");
    const last = samples.length > 0 ? samples[samples.length - 1] : undefined;
    return last?.value ?? 0;
  }

  /** A combined monitoring snapshot at `at`. */
  snapshot(at: string): MonitoringSnapshot {
    return this._engine.snapshot(at);
  }

  /** The current monitoring engine (for direct read access). */
  monitoringEngine(): MonitoringEngine {
    return this._engine;
  }
}

/** Map a `NotificationHealth` status onto the monitoring health status. */
function mapNotificationHealthStatus(
  health: NotificationHealth,
): "healthy" | "warning" | "critical" | "unavailable" {
  switch (health.status) {
    case "healthy":
      return "healthy";
    case "degraded":
      return "warning";
    case "unhealthy":
      return "critical";
    default:
      return "unavailable";
  }
}

/** Build a fresh notifications monitoring bridge. */
export function createNotificationMonitoringBridge(
  options: NotificationMonitoringBridgeOptions = {},
): NotificationMonitoringBridge {
  return new NotificationMonitoringBridge(options);
}
