import { describe, it, expect } from "vitest";
import {
  Logger,
  LoggerFactory,
  LOG_LEVELS,
  LOG_LEVEL_ORDER,
  cloneLogEntry,
  createLogEntry,
  freezeLogEntry,
  hashLogEntry,
  logEntryIdFor,
  logReferences,
  type LogCorrelation,
  type LogScope,
} from "@/lib/monitoring/logger";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:01:00.000Z";

const SCOPE: LogScope = { name: "workers" };

describe("logEntryIdFor / createLogEntry", () => {
  it("derives deterministic ids from level + scope + message + timestamp", () => {
    expect(logEntryIdFor({ level: "info", scope: SCOPE, message: "started", timestamp: NOW })).toBe(
      logEntryIdFor({ level: "info", scope: SCOPE, message: "started", timestamp: NOW }),
    );
    expect(logEntryIdFor({ level: "info", scope: SCOPE, message: "started", timestamp: NOW })).not.toBe(
      logEntryIdFor({ level: "error", scope: SCOPE, message: "started", timestamp: NOW }),
    );
    expect(logEntryIdFor({ level: "info", scope: SCOPE, message: "started", timestamp: NOW })).toMatch(/^log-[0-9a-f]{8}$/);
  });

  it("deep-freezes the entry, correlation, context and tags", () => {
    const entry = createLogEntry({
      level: "info",
      message: "hello",
      scope: SCOPE,
      timestamp: NOW,
      correlation: { requestId: "req-1", workerId: "w1" },
      context: { userId: "u1" },
      metadata: { tags: ["a", "b"] },
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.scope)).toBe(true);
    expect(Object.isFrozen(entry.correlation)).toBe(true);
    expect(Object.isFrozen(entry.context)).toBe(true);
    expect(Object.isFrozen(entry.metadata)).toBe(true);
    expect(Object.isFrozen(entry.metadata.tags)).toBe(true);
  });

  it("normalizes optional fields", () => {
    const entry = createLogEntry({ level: "warn", message: "m", scope: SCOPE, timestamp: NOW });
    expect(entry.correlation).toEqual({});
    expect(entry.context).toEqual({});
    expect(entry.metadata.tags).toEqual([]);
  });
});

describe("clone / freeze / hash", () => {
  it("cloneLogEntry returns a detached mutable copy", () => {
    const entry = createLogEntry({ level: "info", message: "m", scope: SCOPE, timestamp: NOW });
    const clone = cloneLogEntry(entry);
    expect(clone).toEqual(entry);
    expect(clone).not.toBe(entry);
    expect(Object.isFrozen(clone)).toBe(false);
  });

  it("freezeLogEntry is idempotent and freezes nested structures", () => {
    const entry = createLogEntry({ level: "info", message: "m", scope: SCOPE, timestamp: NOW });
    const frozen = freezeLogEntry(entry);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(freezeLogEntry(frozen)).toBe(frozen);
  });

  it("hashLogEntry is stable and sensitive", () => {
    const a = createLogEntry({ level: "info", message: "m", scope: SCOPE, timestamp: NOW });
    const b = createLogEntry({ level: "info", message: "m", scope: SCOPE, timestamp: NOW });
    const c = createLogEntry({ level: "info", message: "other", scope: SCOPE, timestamp: NOW });
    expect(hashLogEntry(a)).toBe(hashLogEntry(b));
    expect(hashLogEntry(a)).not.toBe(hashLogEntry(c));
  });
});

describe("Logger.log", () => {
  it("returns a successor logger and never mutates the receiver", () => {
    const logger = new Logger({ scope: SCOPE });
    const { logger: next, entry } = logger.info("boot", NOW);
    expect(entry?.level).toBe("info");
    expect(logger.count()).toBe(0);
    expect(next.count()).toBe(1);
  });

  it("drops entries below minimumLevel", () => {
    const logger = new Logger({ scope: SCOPE, minimumLevel: "warn" });
    const { logger: next, entry } = logger.debug("noise", NOW);
    expect(entry).toBeUndefined();
    expect(next.count()).toBe(0);
    const { logger: warned } = next.warn("real", LATER);
    expect(warned.count()).toBe(1);
  });

  it("bounds retained entries with maxEntries", () => {
    const logger = new Logger({ scope: SCOPE, maxEntries: 2 });
    let current = logger;
    for (const [, message] of ["a", "b", "c"].entries()) {
      const { logger: next } = current.info(message, NOW);
      current = next;
    }
    expect(current.count()).toBe(2);
    expect(current.list().map((entry) => entry.message)).toEqual(["b", "c"]);
  });

  it("merges correlation and context into the entry", () => {
    const logger = new Logger({ scope: SCOPE, correlation: { requestId: "req-1" } });
    const correlation: LogCorrelation = { workerId: "w1", workflowId: "wf-1" };
    const { logger: next, entry } = logger.info("leased", NOW, {
      correlation,
      context: { taskId: "t1" },
      metadata: { tags: ["lease"] },
    });
    expect(entry?.correlation).toEqual({ requestId: "req-1", workerId: "w1", workflowId: "wf-1" });
    expect(entry?.context).toEqual({ taskId: "t1" });
    expect(entry?.metadata.tags).toEqual(["lease"]);
    expect(next.scope).toEqual(SCOPE);
  });

  it("records every level helper", () => {
    const logger = new Logger({ scope: SCOPE });
    let current = logger;
    const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
    for (const level of levels) {
      const outcome = current[level](`${level}-msg`, NOW);
      expect(outcome.entry?.level).toBe(level);
      current = outcome.logger;
    }
    expect(current.count()).toBe(6);
    expect(current.list().map((entry) => entry.message)).toEqual([
      "trace-msg",
      "debug-msg",
      "info-msg",
      "warn-msg",
      "error-msg",
      "fatal-msg",
    ]);
  });
});

describe("child loggers", () => {
  it("nests the scope label and shares the correlation chain", () => {
    const logger = new Logger({ scope: SCOPE, correlation: { requestId: "req-1" } });
    const child = logger.child({ label: "w1", correlation: { workerId: "w1" } });
    expect(child.scope).toEqual({ name: "workers", label: "w1" });
    expect(child.correlation).toEqual({ requestId: "req-1", workerId: "w1" });
    const grandchild = child.child({ label: "task-1" });
    expect(grandchild.scope.label).toBe("task-1");
  });

  it("children share entries with the parent lineage but are independent successors", () => {
    const logger = new Logger({ scope: SCOPE });
    const child = logger.child({ label: "w1" });
    const { logger: childNext } = child.info("hi", NOW);
    expect(logger.count()).toBe(0);
    expect(child.count()).toBe(0);
    expect(childNext.count()).toBe(1);
  });
});

describe("filter / summary / statistics / references", () => {
  it("filters by minimum level and scope", () => {
    const logger = new Logger({ scope: SCOPE });
    let current = logger;
    current = current.info("a", NOW).logger;
    current = current.error("b", NOW).logger;
    current = current.info("c", NOW).logger;
    const errors = current.filter({ minimumLevel: "error" });
    expect(errors.map((entry) => entry.message)).toEqual(["b"]);
    expect(current.filter({ scope: "other" })).toEqual([]);
  });

  it("logStatistics counts per level", () => {
    const logger = new Logger({ scope: SCOPE });
    let current = logger;
    current = current.info("a", NOW).logger;
    current = current.error("b", NOW).logger;
    current = current.error("c", NOW).logger;
    const stats = current.statistics();
    expect(stats.total).toBe(3);
    expect(stats.byLevel.info).toBe(1);
    expect(stats.byLevel.error).toBe(2);
    expect(stats.byLevel.fatal).toBe(0);
  });

  it("logSummary captures count, window and distinct levels", () => {
    const logger = new Logger({ scope: SCOPE });
    let current = logger;
    current = current.info("a", NOW).logger;
    current = current.warn("b", LATER).logger;
    const summary = current.summary();
    expect(summary.count).toBe(2);
    expect(summary.firstAt).toBe(NOW);
    expect(summary.lastAt).toBe(LATER);
    expect(summary.levels).toEqual(["info", "warn"]);
  });

  it("empty logSummary and logStatistics", () => {
    const logger = new Logger({ scope: SCOPE });
    expect(logger.summary().count).toBe(0);
    expect(logger.summary().firstAt).toBeUndefined();
    expect(logger.statistics().total).toBe(0);
    expect(logReferences([])).toEqual([]);
  });

  it("logReferences projects lightweight entries", () => {
    const logger = new Logger({ scope: SCOPE });
    const { logger: next } = logger.info("x", NOW);
    const refs = logReferences(next.entries);
    expect(refs[0]).toEqual({ id: refs[0]?.id, level: "info", message: "x", timestamp: NOW });
  });
});

describe("snapshot / JSON", () => {
  it("builds a deterministic snapshot at `at`", () => {
    const logger = new Logger({ scope: SCOPE });
    const { logger: next } = logger.info("x", NOW);
    const snapshot = next.snapshot(LATER);
    expect(snapshot.at).toBe(LATER);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.statistics.total).toBe(1);
    expect(snapshot.summary.count).toBe(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("serializes entries deterministically", () => {
    const logger = new Logger({ scope: SCOPE });
    const { logger: next } = logger.info("x", NOW, { context: { a: 1 } });
    expect(next.toJson()).toBe(next.toJson());
    expect(next.toJson()).toContain('"level":"info"');
    expect(next.toJson()).toContain('"message":"x"');
  });

  it("serializes empty loggers consistently", () => {
    const logger = new Logger({ scope: SCOPE });
    expect(logger.toJson()).toBe("[]");
  });
});

describe("LoggerFactory", () => {
  it("creates independent loggers with shared defaults", () => {
    const factory = new LoggerFactory({ scope: { name: "api" }, minimumLevel: "warn" });
    const a = factory.create();
    const b = factory.create();
    expect(a.scope).toEqual({ name: "api" });
    expect(a.minimumLevel).toBe("warn");
    expect(b.minimumLevel).toBe("warn");
    a.info("ignored", NOW);
    expect(b.count()).toBe(0);
  });

  it("scoped builds a logger for a named scope", () => {
    const factory = new LoggerFactory();
    const logger = factory.scoped("digest");
    expect(logger.scope.name).toBe("digest");
  });

  it("create merges factory defaults with overrides", () => {
    const factory = new LoggerFactory({ scope: { name: "app" }, minimumLevel: "info" });
    const logger = factory.create({ scope: { name: "workers" }, minimumLevel: "trace" });
    expect(logger.scope.name).toBe("workers");
    expect(logger.minimumLevel).toBe("trace");
  });
});

describe("LOG_LEVELS / LOG_LEVEL_ORDER", () => {
  it("orders levels ascending", () => {
    expect(LOG_LEVELS).toEqual(["trace", "debug", "info", "warn", "error", "fatal"]);
    expect(LOG_LEVEL_ORDER.trace).toBeLessThan(LOG_LEVEL_ORDER.debug);
    expect(LOG_LEVEL_ORDER.error).toBeLessThan(LOG_LEVEL_ORDER.fatal);
  });
});
