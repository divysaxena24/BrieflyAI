import { describe, it, expect } from "vitest";
import {
  ALERT_RULE_TYPES,
  ALERT_SEVERITIES,
  AlertRegistry,
  alertIdFor,
  alertReferences,
  alertRuleIdFor,
  cloneAlert,
  createAlert,
  createAlertRegistry,
  createAlertRule,
  defaultSeverityFor,
  highestSeverity,
  type AlertRuleType,
} from "@/lib/monitoring/alerts";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:01:00.000Z";
const MUCH_LATER = "2026-08-11T09:02:00.000Z";

const rule = (type: AlertRuleType) =>
  createAlertRule({ type, severity: "warning", dedupeWindowMs: 60_000 });

const base = {
  ruleId: rule("worker_failure").id,
  type: "worker_failure" as AlertRuleType,
  severity: "warning" as const,
  entityId: "w1",
  key: "worker_failure:w1",
  message: "worker failed",
  createdAt: NOW,
};

describe("ids / createAlertRule / createAlert", () => {
  it("derives deterministic ids", () => {
    expect(alertRuleIdFor({ type: "worker_failure", severity: "warning" })).toBe(
      alertRuleIdFor({ type: "worker_failure", severity: "warning" }),
    );
    expect(alertIdFor({ type: "worker_failure", key: "k", createdAt: NOW })).toBe(
      alertIdFor({ type: "worker_failure", key: "k", createdAt: NOW }),
    );
    expect(alertIdFor({ type: "worker_failure", key: "k", createdAt: NOW })).not.toBe(
      alertIdFor({ type: "worker_failure", key: "k", createdAt: LATER }),
    );
    expect(alertIdFor({ type: "worker_failure", key: "k", createdAt: NOW })).toMatch(/^alert-[0-9a-f]{8}$/);
  });

  it("deep-freezes rules and alerts", () => {
    const alert = createAlert({ ...base, attributes: { pool: "main" } });
    expect(Object.isFrozen(alert)).toBe(true);
    expect(alert.attributes && Object.isFrozen(alert.attributes)).toBe(true);
    const createdRule = createAlertRule({ type: "high_latency", severity: "critical" });
    expect(Object.isFrozen(createdRule)).toBe(true);
  });

  it("new alerts start firing with retryCount 0", () => {
    const alert = createAlert(base);
    expect(alert.status).toBe("firing");
    expect(alert.retryCount).toBe(0);
    expect(alert.acknowledgedAt).toBeUndefined();
  });

  it("cloneAlert returns a detached mutable copy", () => {
    const alert = createAlert(base);
    const clone = cloneAlert(alert);
    expect(clone).toEqual(alert);
    expect(clone).not.toBe(alert);
    expect(Object.isFrozen(clone)).toBe(false);
  });
});

describe("AlertRegistry.raise", () => {
  it("raise returns a successor registry; receiver never mutates", () => {
    const registry = createAlertRegistry({ rules: [rule("worker_failure")] });
    const { registry: next, alert } = registry.raise(base);
    expect(alert.status).toBe("firing");
    expect(registry.count()).toBe(0);
    expect(next.count()).toBe(1);
  });

  it("raise works without a registered rule", () => {
    const registry = createAlertRegistry();
    const { registry: next } = registry.raise(base);
    expect(next.count()).toBe(1);
  });

  it("deduplicates identical open alerts within the window", () => {
    const registry = createAlertRegistry({ rules: [rule("worker_failure")] });
    const { registry: a } = registry.raise(base);
    const { registry: b, alert } = a.raise({ ...base, createdAt: LATER });
    expect(b.count()).toBe(1);
    expect(alert?.retryCount).toBe(1);
  });

  it("does not deduplicate different keys", () => {
    const registry = createAlertRegistry({ rules: [rule("worker_failure")] });
    const { registry: a } = registry.raise(base);
    const { registry: b } = a.raise({ ...base, key: "worker_failure:w2", entityId: "w2" });
    expect(b.count()).toBe(2);
  });

  it("does not deduplicate outside the window", () => {
    const registry = createAlertRegistry({ rules: [rule("worker_failure")] });
    const { registry: a } = registry.raise(base);
    const { registry: b } = a.raise({ ...base, createdAt: MUCH_LATER });
    expect(b.count()).toBe(2);
  });

  it("suppressed rules produce suppressed alerts", () => {
    const suppressedRule = createAlertRule({
      type: "worker_failure",
      severity: "warning",
      suppressed: true,
    });
    const registry = createAlertRegistry({ rules: [suppressedRule] });
    const { alert } = registry.raise(base);
    expect(alert.status).toBe("suppressed");
  });

  it("bounds retained alerts with maxAlerts", () => {
    const registry = new AlertRegistry({ maxAlerts: 2 });
    let current = registry;
    for (let index = 0; index < 3; index += 1) {
      const { registry: next } = current.raise({
        ...base,
        key: `key-${index}`,
        entityId: `e${index}`,
        createdAt: NOW,
      });
      current = next;
    }
    expect(current.count()).toBe(2);
  });
});

describe("acknowledge / suppress / resolve / retry", () => {
  it("acknowledge stamps actor and time", () => {
    const registry = createAlertRegistry({ rules: [rule("worker_failure")] });
    const { registry: a, alert: raised } = registry.raise(base);
    const { registry: b, alert } = a.acknowledge(raised!.id, LATER, "ops");
    expect(alert?.status).toBe("acknowledged");
    expect(alert?.acknowledgedBy).toBe("ops");
    expect(alert?.acknowledgedAt).toBe(LATER);
    expect(b.findById(raised!.id)?.status).toBe("acknowledged");
  });

  it("acknowledge on unknown or resolved alerts is a no-op", () => {
    const registry = createAlertRegistry();
    expect(registry.acknowledge("nope", LATER).alert).toBeUndefined();
    const { registry: a, alert: raised } = registry.raise(base);
    const { registry: b } = a.resolve(raised!.id, LATER);
    expect(b.acknowledge(raised!.id, MUCH_LATER).alert).toBeUndefined();
  });

  it("suppress marks an alert suppressed", () => {
    const registry = createAlertRegistry();
    const { registry: a, alert: raised } = registry.raise(base);
    const { alert } = a.suppress(raised!.id, LATER);
    expect(alert?.status).toBe("suppressed");
  });

  it("resolve marks an alert resolved", () => {
    const registry = createAlertRegistry();
    const { registry: a, alert: raised } = registry.raise(base);
    const { alert } = a.resolve(raised!.id, LATER);
    expect(alert?.status).toBe("resolved");
    expect(alert?.resolvedAt).toBe(LATER);
  });

  it("retry re-raises and bumps the retry count", () => {
    const registry = createAlertRegistry();
    const { registry: a, alert: raised } = registry.raise(base);
    const { registry: b } = a.resolve(raised!.id, LATER);
    const { alert } = b.retry(raised!.id, MUCH_LATER);
    expect(alert?.status).toBe("firing");
    expect(alert?.retryCount).toBe(1);
    expect(alert?.resolvedAt).toBeUndefined();
    expect(alert?.createdAt).toBe(MUCH_LATER);
  });

  it("retry on unknown alerts is a no-op", () => {
    const registry = createAlertRegistry();
    expect(registry.retry("nope", LATER).alert).toBeUndefined();
  });
});

describe("find / rules / statistics / summary", () => {
  it("find filters by type and status", () => {
    const registry = createAlertRegistry();
    const { registry: a } = registry.raise({ ...base, type: "worker_failure", key: "k1" });
    const { registry: b } = a.raise({ ...base, type: "workflow_failure", key: "k2", ruleId: "r2" });
    expect(b.find({ type: "worker_failure" })).toHaveLength(1);
    expect(b.find({ status: "firing" })).toHaveLength(2);
    expect(b.find({ status: "resolved" })).toHaveLength(0);
  });

  it("openForKey lists non-resolved alerts", () => {
    const registry = createAlertRegistry();
    const { registry: a } = registry.raise(base);
    const { registry: b, alert: raised } = a.raise({ ...base, createdAt: LATER });
    expect(b.openForKey(base.key)).toHaveLength(2);
    const { registry: c } = b.resolve(raised!.id, MUCH_LATER);
    expect(c.openForKey(base.key)).toHaveLength(1);
  });

  it("rulesForType and rule lookups", () => {
    const registry = createAlertRegistry({
      rules: [rule("worker_failure"), rule("high_latency")],
    });
    expect(registry.rulesForType("worker_failure")).toHaveLength(1);
    expect(registry.rule(rule("worker_failure").id)?.type).toBe("worker_failure");
    expect(registry.rule("nope")).toBeUndefined();
  });

  it("registerRule rejects duplicates", () => {
    const registry = createAlertRegistry({ rules: [rule("worker_failure")] });
    expect(() => registry.registerRule({ type: "worker_failure", severity: "warning" })).toThrow();
  });

  it("alertStatistics counts statuses, types and severities", () => {
    const registry = createAlertRegistry();
    const { registry: a } = registry.raise({ ...base, severity: "critical" });
    const { registry: b } = a.raise({ ...base, type: "high_latency", key: "k2", severity: "warning", ruleId: "r2" });
    const stats = b.statistics();
    expect(stats.total).toBe(2);
    expect(stats.firing).toBe(2);
    expect(stats.byType.worker_failure).toBe(1);
    expect(stats.byType.high_latency).toBe(1);
    expect(stats.bySeverity.critical).toBe(1);
    expect(stats.bySeverity.warning).toBe(1);
  });

  it("alertSummary computes overall view", () => {
    const registry = createAlertRegistry();
    const { registry: a } = registry.raise({ ...base, severity: "critical" });
    const summary = a.summary();
    expect(summary.total).toBe(1);
    expect(summary.firing).toBe(1);
    expect(summary.highestSeverity).toBe("critical");
  });

  it("highestSeverity over empty alerts is info", () => {
    expect(highestSeverity([])).toBe("info");
  });

  it("alertReferences projects lightweight entries", () => {
    const registry = createAlertRegistry();
    const { registry: a } = registry.raise(base);
    const refs = alertReferences(a.alerts);
    expect(refs[0]?.type).toBe("worker_failure");
    expect(refs[0]?.status).toBe("firing");
  });
});

describe("snapshot / defaults / constants", () => {
  it("builds a deterministic snapshot at `at`", () => {
    const registry = createAlertRegistry();
    const { registry: a } = registry.raise(base);
    const snapshot = a.snapshot(LATER);
    expect(snapshot.at).toBe(LATER);
    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.statistics.total).toBe(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("defaultSeverityFor returns sensible severities", () => {
    expect(defaultSeverityFor("database_unavailable")).toBe("critical");
    expect(defaultSeverityFor("persistence_failure")).toBe("critical");
    expect(defaultSeverityFor("worker_failure")).toBe("warning");
  });

  it("ALERT_RULE_TYPES covers every rule", () => {
    const types: readonly AlertRuleType[] = [
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
    ];
    expect(ALERT_RULE_TYPES).toEqual(types);
  });

  it("ALERT_SEVERITIES ranks severity", () => {
    expect(ALERT_SEVERITIES).toEqual(["info", "warning", "critical", "fatal"]);
  });
});
