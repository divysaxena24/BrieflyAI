/**
 * Observability & Monitoring — alert engine (Phase 6C STEP 7).
 *
 * Immutable, successor-based alerting. Alert rules describe conditions
 * (worker failure, database unavailable, workflow failure, high latency,
 * queue overflow, persistence failure, tool failure, planner failure,
 * digest failure, action failure). An `AlertRegistry` raises, acknowledges,
 * suppresses, deduplicates and retries alerts — every transition returns a
 * successor registry. No notifications are sent here; this is pure backend
 * state. All timestamps are caller-supplied.
 */

import { hashString } from "@/lib/hash";

/** The severity of an alert. */
export type AlertSeverity = "info" | "warning" | "critical" | "fatal";

/** Every severity in ascending order. */
export const ALERT_SEVERITIES: readonly AlertSeverity[] = Object.freeze([
  "info",
  "warning",
  "critical",
  "fatal",
]);

/** The condition an alert rule detects. */
export type AlertRuleType =
  | "worker_failure"
  | "database_unavailable"
  | "workflow_failure"
  | "high_latency"
  | "queue_overflow"
  | "persistence_failure"
  | "tool_failure"
  | "planner_failure"
  | "digest_failure"
  | "action_failure";

/** Every alert rule type in a stable canonical order. */
export const ALERT_RULE_TYPES: readonly AlertRuleType[] = Object.freeze([
  "worker_failure",
  "database_unavailable",
  "workflow_failure",
  "high_latency",
  "queue_overflow",
  "persistence_failure",
  "tool_failure",
  "planner_failure",
  "digest_failure",
  "action_failure",
]);

/** The lifecycle state of an alert. */
export type AlertStatus = "firing" | "acknowledged" | "suppressed" | "resolved";

/** A rule describing when to raise an alert. */
export interface AlertRule {
  /** Stable rule id: `alert-rule-<hash(type:severity)>`. */
  readonly id: string;
  readonly type: AlertRuleType;
  readonly severity: AlertSeverity;
  readonly description?: string;
  /** Dedupe window in milliseconds: identical alerts within the window merge. */
  readonly dedupeWindowMs?: number;
  /** When set, alerts matching the key are suppressed while the rule is active. */
  readonly suppressed?: boolean;
}

/** A single immutable alert. */
export interface Alert {
  /** Stable id: `alert-<hash(type:key:timestamp)>`. */
  readonly id: string;
  readonly ruleId: string;
  readonly type: AlertRuleType;
  readonly severity: AlertSeverity;
  /** Entity the alert is about (worker, job, workflow, …). */
  readonly entityId: string;
  /** Dedupe key (type + entityId + optional discriminator). */
  readonly key: string;
  readonly message: string;
  /** ISO-8601 UTC timestamps, caller-supplied. */
  readonly createdAt: string;
  readonly acknowledgedAt?: string;
  readonly resolvedAt?: string;
  readonly acknowledgedBy?: string;
  readonly status: AlertStatus;
  readonly retryCount: number;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** A lightweight projection of an alert. */
export interface AlertReference {
  readonly id: string;
  readonly type: AlertRuleType;
  readonly severity: AlertSeverity;
  readonly entityId: string;
  readonly status: AlertStatus;
  readonly createdAt: string;
}

/** Aggregate statistics over a set of alerts. */
export interface AlertStatistics {
  readonly total: number;
  readonly firing: number;
  readonly acknowledged: number;
  readonly suppressed: number;
  readonly resolved: number;
  readonly byType: Readonly<Record<AlertRuleType, number>>;
  readonly bySeverity: Readonly<Record<AlertSeverity, number>>;
  readonly retried: number;
}

/** Compact summary of the alert registry. */
export interface AlertSummary {
  readonly total: number;
  readonly firing: number;
  readonly acknowledged: number;
  readonly suppressed: number;
  readonly resolved: number;
  readonly highestSeverity: AlertSeverity;
}

/** Point-in-time snapshot of an alert registry. */
export interface AlertSnapshot {
  readonly at: string;
  readonly alerts: readonly Alert[];
  readonly statistics: AlertStatistics;
  readonly summary: AlertSummary;
}

/** Input accepted by {@link createAlert}. */
export interface CreateAlertInput {
  readonly ruleId: string;
  readonly type: AlertRuleType;
  readonly severity: AlertSeverity;
  readonly entityId: string;
  readonly key: string;
  readonly message: string;
  readonly createdAt: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** Input accepted by {@link AlertRegistry.registerRule}. */
export interface CreateAlertRuleInput {
  readonly type: AlertRuleType;
  readonly severity: AlertSeverity;
  readonly description?: string;
  readonly dedupeWindowMs?: number;
  readonly suppressed?: boolean;
}

/** Deterministic id for an alert. */
export function alertIdFor(input: {
  readonly type: AlertRuleType;
  readonly key: string;
  readonly createdAt: string;
}): string {
  return `alert-${hashString(`${input.type}:${input.key}:${input.createdAt}`)}`;
}

/** Deterministic id for an alert rule. */
export function alertRuleIdFor(input: {
  readonly type: AlertRuleType;
  readonly severity: AlertSeverity;
}): string {
  return `alert-rule-${hashString(`${input.type}:${input.severity}`)}`;
}

/** Build a new immutable alert rule. */
export function createAlertRule(input: CreateAlertRuleInput): AlertRule {
  return Object.freeze({
    id: alertRuleIdFor(input),
    type: input.type,
    severity: input.severity,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.dedupeWindowMs !== undefined ? { dedupeWindowMs: input.dedupeWindowMs } : {}),
    ...(input.suppressed !== undefined ? { suppressed: input.suppressed } : {}),
  });
}

/** Build a new immutable alert. */
export function createAlert(input: CreateAlertInput): Alert {
  return Object.freeze({
    id: alertIdFor(input),
    ruleId: input.ruleId,
    type: input.type,
    severity: input.severity,
    entityId: input.entityId,
    key: input.key,
    message: input.message,
    createdAt: input.createdAt,
    status: "firing",
    retryCount: 0,
    ...(input.attributes !== undefined
      ? { attributes: Object.freeze({ ...input.attributes }) }
      : {}),
  });
}

/** Return a deep, detached copy of an alert (never frozen). */
export function cloneAlert(alert: Alert): Alert {
  return {
    id: alert.id,
    ruleId: alert.ruleId,
    type: alert.type,
    severity: alert.severity,
    entityId: alert.entityId,
    key: alert.key,
    message: alert.message,
    createdAt: alert.createdAt,
    ...(alert.acknowledgedAt !== undefined ? { acknowledgedAt: alert.acknowledgedAt } : {}),
    ...(alert.resolvedAt !== undefined ? { resolvedAt: alert.resolvedAt } : {}),
    ...(alert.acknowledgedBy !== undefined ? { acknowledgedBy: alert.acknowledgedBy } : {}),
    status: alert.status,
    retryCount: alert.retryCount,
    ...(alert.attributes !== undefined ? { attributes: { ...alert.attributes } } : {}),
  };
}

/** Aggregate statistics over a set of alerts. */
export function alertStatistics(alerts: readonly Alert[]): AlertStatistics {
  const byType: Record<AlertRuleType, number> = {
    worker_failure: 0,
    database_unavailable: 0,
    workflow_failure: 0,
    high_latency: 0,
    queue_overflow: 0,
    persistence_failure: 0,
    tool_failure: 0,
    planner_failure: 0,
    digest_failure: 0,
    action_failure: 0,
  };
  const bySeverity: Record<AlertSeverity, number> = {
    info: 0,
    warning: 0,
    critical: 0,
    fatal: 0,
  };
  let firing = 0;
  let acknowledged = 0;
  let suppressed = 0;
  let resolved = 0;
  let retried = 0;
  for (const alert of alerts) {
    byType[alert.type] += 1;
    bySeverity[alert.severity] += 1;
    if (alert.status === "firing") firing += 1;
    if (alert.status === "acknowledged") acknowledged += 1;
    if (alert.status === "suppressed") suppressed += 1;
    if (alert.status === "resolved") resolved += 1;
    retried += alert.retryCount;
  }
  return Object.freeze({
    total: alerts.length,
    firing,
    acknowledged,
    suppressed,
    resolved,
    byType: Object.freeze(byType),
    bySeverity: Object.freeze(bySeverity),
    retried,
  });
}

/** The highest severity present in a set of alerts. */
export function highestSeverity(alerts: readonly Alert[]): AlertSeverity {
  let highest: AlertSeverity = "info";
  for (const alert of alerts) {
    const order = (severity: AlertSeverity): number => ALERT_SEVERITIES.indexOf(severity);
    if (order(alert.severity) > order(highest)) highest = alert.severity;
  }
  return highest;
}

/** Compact summary of a set of alerts. */
export function alertSummary(alerts: readonly Alert[]): AlertSummary {
  const stats = alertStatistics(alerts);
  return Object.freeze({
    total: stats.total,
    firing: stats.firing,
    acknowledged: stats.acknowledged,
    suppressed: stats.suppressed,
    resolved: stats.resolved,
    highestSeverity: highestSeverity(alerts),
  });
}

/** Project every alert to a lightweight reference. */
export function alertReferences(alerts: readonly Alert[]): readonly AlertReference[] {
  return Object.freeze(
    alerts.map((alert) =>
      Object.freeze({
        id: alert.id,
        type: alert.type,
        severity: alert.severity,
        entityId: alert.entityId,
        status: alert.status,
        createdAt: alert.createdAt,
      }),
    ),
  );
}

/** Options accepted by the {@link AlertRegistry} constructor. */
export interface AlertRegistryOptions {
  readonly rules?: readonly AlertRule[];
  readonly alerts?: readonly Alert[];
  readonly maxAlerts?: number;
}

/**
 * An immutable alert registry. Every transition (`raise`, `acknowledge`,
 * `suppress`, `resolve`, `retry`) returns a successor registry. `raise`
 * deduplicates: an open alert with the same `key` within the rule's
 * `dedupeWindowMs` merges instead of duplicating. Suppressed rules produce
 * `suppressed` alerts. Nothing is sent anywhere — pure backend state.
 */
export class AlertRegistry {
  readonly rules: readonly AlertRule[];
  readonly alerts: readonly Alert[];

  private readonly maxAlerts: number | undefined;

  constructor(options: AlertRegistryOptions = {}) {
    this.rules = Object.freeze([...(options.rules ?? [])].map((rule) => Object.freeze({ ...rule })));
    this.alerts = Object.freeze([...(options.alerts ?? [])].map(cloneAlert));
    this.maxAlerts = options.maxAlerts;
  }

  /** Build a successor registry from partial state. */
  private next(partial: { rules: readonly AlertRule[]; alerts: readonly Alert[] }): AlertRegistry {
    return new AlertRegistry({ rules: partial.rules, alerts: partial.alerts, maxAlerts: this.maxAlerts });
  }

  /** The number of retained alerts. */
  count(): number {
    return this.alerts.length;
  }

  /** The number of registered rules. */
  ruleCount(): number {
    return this.rules.length;
  }

  /** Register a rule; returns the successor registry. */
  registerRule(input: CreateAlertRuleInput): AlertRegistry {
    const rule = createAlertRule(input);
    if (this.rules.some((candidate) => candidate.id === rule.id)) {
      throw new Error(`Alert rule already registered: ${rule.id}`);
    }
    return this.next({ rules: [...this.rules, rule], alerts: this.alerts });
  }

  /** The rule for `ruleId`, or `undefined`. */
  rule(ruleId: string): AlertRule | undefined {
    const rule = this.rules.find((candidate) => candidate.id === ruleId);
    return rule === undefined ? undefined : { ...rule };
  }

  /** Rules matching `type`. */
  rulesForType(type: AlertRuleType): readonly AlertRule[] {
    return this.rules.filter((rule) => rule.type === type);
  }

  /** Detached copies of every retained alert. */
  list(): Alert[] {
    return this.alerts.map(cloneAlert);
  }

  /** Alerts matching `type` and/or `status`. */
  find(options: { type?: AlertRuleType; status?: AlertStatus } = {}): Alert[] {
    return this.alerts
      .filter((alert) => options.type === undefined || alert.type === options.type)
      .filter((alert) => options.status === undefined || alert.status === options.status)
      .map(cloneAlert);
  }

  /** The alert with `alertId`, or `undefined`. */
  findById(alertId: string): Alert | undefined {
    const alert = this.alerts.find((candidate) => candidate.id === alertId);
    return alert === undefined ? undefined : cloneAlert(alert);
  }

  /** Open (firing/acknowledged/suppressed) alerts for `key`. */
  openForKey(key: string): Alert[] {
    return this.alerts
      .filter((alert) => alert.key === key && alert.status !== "resolved")
      .map(cloneAlert);
  }

  /**
   * Raise an alert for `ruleId`. When no rule matches, the alert is still
   * raised with the supplied severity (fire-and-forget rules are allowed
   * for callers that evaluate conditions themselves). Deduplication merges
   * an identical open alert within the rule's window.
   */
  raise(input: CreateAlertInput): { registry: AlertRegistry; alert: Alert } {
    const rule = this.rule(input.ruleId);
    const suppressed = rule?.suppressed === true;
    const dedupeWindowMs = rule?.dedupeWindowMs;

    if (dedupeWindowMs !== undefined) {
      const cutoff = Date.parse(input.createdAt) - dedupeWindowMs;
      const duplicate = this.alerts.find(
        (alert) =>
          alert.key === input.key &&
          alert.status !== "resolved" &&
          Date.parse(alert.createdAt) >= cutoff,
      );
      if (duplicate !== undefined) {
        // Merge: keep the existing alert, bump its retry count.
        const merged: Alert = Object.freeze({
          ...duplicate,
          retryCount: duplicate.retryCount + 1,
          ...(suppressed ? { status: "suppressed" as const } : {}),
        });
        const alerts = this.alerts.map((alert) => (alert.id === duplicate.id ? merged : alert));
        return { registry: this.next({ rules: this.rules, alerts }), alert: cloneAlert(merged) };
      }
    }

    const alert = createAlert(input);
    const stored: Alert =
      suppressed && alert.status === "firing"
        ? Object.freeze({ ...alert, status: "suppressed" as const })
        : alert;
    let alerts = [...this.alerts, stored];
    if (this.maxAlerts !== undefined && alerts.length > this.maxAlerts) {
      alerts = alerts.slice(alerts.length - this.maxAlerts);
    }
    return { registry: this.next({ rules: this.rules, alerts }), alert: cloneAlert(stored) };
  }

  /** Acknowledge an alert (caller-supplied actor and time). */
  acknowledge(
    alertId: string,
    at: string,
    actor?: string,
  ): { registry: AlertRegistry; alert?: Alert } {
    const existing = this.findById(alertId);
    if (existing === undefined || existing.status === "resolved") return { registry: this };
    const updated: Alert = Object.freeze({
      ...existing,
      status: "acknowledged",
      acknowledgedAt: at,
      ...(actor !== undefined ? { acknowledgedBy: actor } : {}),
    });
    const alerts = this.alerts.map((alert) => (alert.id === alertId ? updated : alert));
    return { registry: this.next({ rules: this.rules, alerts }), alert: cloneAlert(updated) };
  }

  /** Suppress a firing/acknowledged alert. */
  suppress(alertId: string, at: string): { registry: AlertRegistry; alert?: Alert } {
    const existing = this.findById(alertId);
    if (existing === undefined || existing.status === "resolved") return { registry: this };
    const updated: Alert = Object.freeze({ ...existing, status: "suppressed", acknowledgedAt: at });
    const alerts = this.alerts.map((alert) => (alert.id === alertId ? updated : alert));
    return { registry: this.next({ rules: this.rules, alerts }), alert: cloneAlert(updated) };
  }

  /** Resolve an open alert. */
  resolve(alertId: string, at: string): { registry: AlertRegistry; alert?: Alert } {
    const existing = this.findById(alertId);
    if (existing === undefined || existing.status === "resolved") return { registry: this };
    const updated: Alert = Object.freeze({ ...existing, status: "resolved", resolvedAt: at });
    const alerts = this.alerts.map((alert) => (alert.id === alertId ? updated : alert));
    return { registry: this.next({ rules: this.rules, alerts }), alert: cloneAlert(updated) };
  }

  /** Re-raise a resolved/suppressed alert (bumps retry count). */
  retry(
    alertId: string,
    at: string,
  ): { registry: AlertRegistry; alert?: Alert } {
    const existing = this.findById(alertId);
    if (existing === undefined) return { registry: this };
    const updated: Alert = Object.freeze({
      id: existing.id,
      ruleId: existing.ruleId,
      type: existing.type,
      severity: existing.severity,
      entityId: existing.entityId,
      key: existing.key,
      message: existing.message,
      status: "firing",
      retryCount: existing.retryCount + 1,
      createdAt: at,
      ...(existing.attributes !== undefined ? { attributes: existing.attributes } : {}),
    });
    const alerts = this.alerts.map((alert) => (alert.id === alertId ? updated : alert));
    return { registry: this.next({ rules: this.rules, alerts }), alert: cloneAlert(updated) };
  }

  /** Aggregate statistics over all retained alerts. */
  statistics(): AlertStatistics {
    return alertStatistics(this.alerts);
  }

  /** Compact summary of the registry. */
  summary(): AlertSummary {
    return alertSummary(this.alerts);
  }

  /** Point-in-time snapshot at `at`. */
  snapshot(at: string): AlertSnapshot {
    return Object.freeze({
      at,
      alerts: this.list(),
      statistics: this.statistics(),
      summary: this.summary(),
    });
  }
}

/** Build a fresh alert registry. */
export function createAlertRegistry(options: AlertRegistryOptions = {}): AlertRegistry {
  return new AlertRegistry(options);
}

/** The default severity for a rule type. */
export function defaultSeverityFor(type: AlertRuleType): AlertSeverity {
  switch (type) {
    case "database_unavailable":
    case "persistence_failure":
      return "critical";
    case "worker_failure":
    case "workflow_failure":
    case "digest_failure":
    case "action_failure":
      return "warning";
    case "high_latency":
    case "queue_overflow":
    case "tool_failure":
    case "planner_failure":
      return "warning";
    default:
      return "warning";
  }
}
