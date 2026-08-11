import { describe, it, expect } from "vitest";
import {
  HEALTH_COMPONENTS,
  HEALTH_STATUSES,
  buildHealthReport,
  cloneHealthEntry,
  createHealthEntry,
  createHealthRegistry,
  healthEntryIdFor,
  healthStatistics,
  healthSummary,
  healthyProbe,
  overallStatus,
  unhealthyProbe,
  worstStatus,
  type HealthComponent,
} from "@/lib/monitoring/health";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:01:00.000Z";

describe("healthEntryIdFor / createHealthEntry", () => {
  it("derives deterministic ids", () => {
    expect(healthEntryIdFor({ component: "database", timestamp: NOW })).toBe(
      healthEntryIdFor({ component: "database", timestamp: NOW }),
    );
    expect(healthEntryIdFor({ component: "database", timestamp: NOW })).not.toBe(
      healthEntryIdFor({ component: "workers", timestamp: NOW }),
    );
    expect(healthEntryIdFor({ component: "database", timestamp: NOW })).toMatch(/^health-[0-9a-f]{8}$/);
  });

  it("deep-freezes entries and details", () => {
    const entry = createHealthEntry({
      component: "database",
      status: "healthy",
      timestamp: NOW,
      message: "ok",
      details: { version: 1 },
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.details && Object.isFrozen(entry.details)).toBe(true);
  });

  it("cloneHealthEntry returns a detached mutable copy", () => {
    const entry = createHealthEntry({
      component: "api",
      status: "warning",
      timestamp: NOW,
      message: "slow",
    });
    const clone = cloneHealthEntry(entry);
    expect(clone).toEqual(entry);
    expect(clone).not.toBe(entry);
    expect(Object.isFrozen(clone)).toBe(false);
  });
});

describe("worstStatus / healthSummary / healthStatistics", () => {
  it("worstStatus ranks unavailable over critical over warning over healthy", () => {
    expect(worstStatus([])).toBe("healthy");
    const healthy = createHealthEntry({ component: "api", status: "healthy", timestamp: NOW, message: "" });
    const warning = createHealthEntry({ component: "api", status: "warning", timestamp: NOW, message: "" });
    const critical = createHealthEntry({ component: "api", status: "critical", timestamp: NOW, message: "" });
    const unavailable = createHealthEntry({ component: "api", status: "unavailable", timestamp: NOW, message: "" });
    expect(worstStatus([healthy])).toBe("healthy");
    expect(worstStatus([healthy, warning])).toBe("warning");
    expect(worstStatus([warning, critical])).toBe("critical");
    expect(worstStatus([critical, unavailable])).toBe("unavailable");
  });

  it("healthStatistics counts per status", () => {
    const entries = [
      createHealthEntry({ component: "api", status: "healthy", timestamp: NOW, message: "" }),
      createHealthEntry({ component: "api", status: "warning", timestamp: NOW, message: "" }),
      createHealthEntry({ component: "api", status: "critical", timestamp: NOW, message: "" }),
      createHealthEntry({ component: "api", status: "critical", timestamp: NOW, message: "" }),
    ];
    const stats = healthStatistics(entries);
    expect(stats.total).toBe(4);
    expect(stats.byStatus.healthy).toBe(1);
    expect(stats.byStatus.warning).toBe(1);
    expect(stats.byStatus.critical).toBe(2);
    expect(stats.byStatus.unavailable).toBe(0);
    expect(stats.criticalCount).toBe(2);
  });

  it("healthSummary aggregates overall status", () => {
    const entries = [
      createHealthEntry({ component: "database", status: "healthy", timestamp: NOW, message: "" }),
      createHealthEntry({ component: "workers", status: "critical", timestamp: NOW, message: "" }),
    ];
    const summary = healthSummary(entries);
    expect(summary.overall).toBe("critical");
    expect(summary.total).toBe(2);
    expect(summary.healthy).toBe(1);
    expect(summary.critical).toBe(1);
  });

  it("buildHealthReport produces a frozen report", () => {
    const entries = [
      createHealthEntry({ component: "database", status: "healthy", timestamp: NOW, message: "ok" }),
    ];
    const report = buildHealthReport(LATER, entries);
    expect(report.at).toBe(LATER);
    expect(report.entries).toHaveLength(1);
    expect(report.summary.overall).toBe("healthy");
    expect(overallStatus(report)).toBe("healthy");
    expect(Object.isFrozen(report)).toBe(true);
  });
});

describe("HealthRegistry.register / check", () => {
  it("register returns a successor registry; receiver never mutates", () => {
    const registry = createHealthRegistry();
    const next = registry.register(healthyProbe("database"));
    expect(registry.count()).toBe(0);
    expect(next.count()).toBe(1);
  });

  it("register rejects duplicate components", () => {
    const registry = createHealthRegistry({ probes: [healthyProbe("database")] });
    expect(() => registry.register(healthyProbe("database"))).toThrow();
  });

  it("check evaluates a healthy probe", async () => {
    const registry = createHealthRegistry({ probes: [healthyProbe("database")] });
    const { registry: next, entry } = await registry.check("database", NOW);
    expect(entry.status).toBe("healthy");
    expect(entry.component).toBe("database");
    expect(next.history).toHaveLength(1);
  });

  it("check isolates a throwing probe into unavailable", async () => {
    const registry = createHealthRegistry({
      probes: [
        {
          component: "persistence",
          run: async () => {
            throw new Error("disk full");
          },
        },
      ],
    });
    const { entry } = await registry.check("persistence", NOW);
    expect(entry.status).toBe("unavailable");
    expect(entry.message).toContain("disk full");
  });

  it("check on an unregistered component yields unavailable", async () => {
    const registry = createHealthRegistry();
    const { entry } = await registry.check("api", NOW);
    expect(entry.status).toBe("unavailable");
  });

  it("check measures duration via injected clock", async () => {
    let clock = 0;
    const registry = createHealthRegistry({ probes: [healthyProbe("database")] });
    const { entry } = await registry.check("database", NOW, () => {
      clock += 10;
      return clock;
    });
    expect(entry.durationMs).toBe(10);
  });
});

describe("HealthRegistry.runAll", () => {
  it("evaluates every probe in registration order", async () => {
    const registry = createHealthRegistry({
      probes: [healthyProbe("database"), unhealthyProbe("workers", "down")],
    });
    const { registry: next, report } = await registry.runAll(NOW);
    expect(report.entries.map((entry) => entry.component)).toEqual(["database", "workers"]);
    expect(report.summary.overall).toBe("critical");
    expect(report.statistics.total).toBe(2);
    expect(next.history).toHaveLength(2);
  });

  it("failure isolation keeps later probes running", async () => {
    const registry = createHealthRegistry({
      probes: [
        { component: "persistence", run: async () => Promise.reject(new Error("boom")) },
        healthyProbe("memory_engine"),
      ],
    });
    const { report } = await registry.runAll(NOW);
    expect(report.entries[0]?.status).toBe("unavailable");
    expect(report.entries[1]?.status).toBe("healthy");
  });
});

describe("history / latest / report", () => {
  it("latest returns the most recent entry per component", async () => {
    let registry = createHealthRegistry({ probes: [healthyProbe("database")] });
    ({ registry } = await registry.check("database", NOW));
    ({ registry } = await registry.check("database", LATER));
    expect(registry.latest("database")?.timestamp).toBe(LATER);
    expect(registry.latest("missing")).toBeUndefined();
  });

  it("forComponent returns all entries oldest first", async () => {
    let registry = createHealthRegistry({ probes: [healthyProbe("database")] });
    ({ registry } = await registry.check("database", NOW));
    ({ registry } = await registry.check("database", LATER));
    expect(registry.forComponent("database")).toHaveLength(2);
  });

  it("report reflects the latest status of every probed component", async () => {
    let registry = createHealthRegistry({ probes: [healthyProbe("database")] });
    ({ registry } = await registry.check("database", NOW));
    const report = registry.report(LATER);
    expect(report.at).toBe(LATER);
    expect(report.entries).toHaveLength(1);
  });

  it("snapshot freezes the report", async () => {
    let registry = createHealthRegistry({ probes: [healthyProbe("database")] });
    ({ registry } = await registry.check("database", NOW));
    const snapshot = registry.snapshot(LATER);
    expect(snapshot.at).toBe(LATER);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

describe("probe helpers / constants", () => {
  it("unhealthyProbe builds non-healthy probes", async () => {
    const probe = unhealthyProbe("workers", "no heartbeat");
    const entry = await probe.run();
    expect(entry.status).toBe("critical");
    expect(entry.message).toBe("no heartbeat");
  });

  it("HEALTH_COMPONENTS covers every component", () => {
    const components: readonly HealthComponent[] = [
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
    ];
    expect(HEALTH_COMPONENTS).toEqual(components);
  });

  it("HEALTH_STATUSES ranks severity", () => {
    expect(HEALTH_STATUSES).toEqual(["healthy", "warning", "critical", "unavailable"]);
  });
});
