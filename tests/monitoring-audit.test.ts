import { describe, it, expect } from "vitest";
import {
  AUDIT_ACTIONS,
  AuditStore,
  auditEntryIdFor,
  auditReferences,
  cloneAuditEntry,
  createAuditEntry,
  createAuditStore,
  freezeAuditEntry,
  hashAuditEntry,
  type AuditAction,
} from "@/lib/monitoring/audit";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:01:00.000Z";

const base = {
  actor: "user-1",
  resource: "conversation",
  resourceId: "conv-1",
  action: "conversation_update" as AuditAction,
  timestamp: NOW,
};

describe("auditEntryIdFor / createAuditEntry", () => {
  it("derives deterministic ids", () => {
    expect(auditEntryIdFor({ actor: "u1", resource: "memory", action: "memory_change", timestamp: NOW })).toBe(
      auditEntryIdFor({ actor: "u1", resource: "memory", action: "memory_change", timestamp: NOW }),
    );
    expect(auditEntryIdFor({ actor: "u1", resource: "memory", action: "memory_change", timestamp: NOW })).not.toBe(
      auditEntryIdFor({ actor: "u2", resource: "memory", action: "memory_change", timestamp: NOW }),
    );
    expect(auditEntryIdFor({ actor: "u1", resource: "memory", action: "memory_change", timestamp: NOW })).toMatch(
      /^audit-[0-9a-f]{8}$/,
    );
  });

  it("deep-freezes entries, metadata and correlation", () => {
    const entry = createAuditEntry({
      ...base,
      metadata: { scope: "app" },
      correlation: { correlationId: "c1", requestId: "r1" },
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.metadata && Object.isFrozen(entry.metadata)).toBe(true);
    expect(entry.correlation && Object.isFrozen(entry.correlation)).toBe(true);
  });

  it("normalizes optional fields", () => {
    const entry = createAuditEntry(base);
    expect(entry.resourceId).toBe("conv-1");
    expect(entry.reason).toBeUndefined();
    expect(entry.metadata).toBeUndefined();
    expect(entry.correlation).toBeUndefined();
    expect(entry.outcome).toBeUndefined();
  });

  it("cloneAuditEntry returns a detached mutable copy", () => {
    const entry = createAuditEntry(base);
    const clone = cloneAuditEntry(entry);
    expect(clone).toEqual(entry);
    expect(clone).not.toBe(entry);
    expect(Object.isFrozen(clone)).toBe(false);
  });

  it("freezeAuditEntry is idempotent", () => {
    const entry = createAuditEntry(base);
    expect(freezeAuditEntry(freezeAuditEntry(entry))).toBe(freezeAuditEntry(entry));
  });

  it("hashAuditEntry is stable and sensitive", () => {
    const a = createAuditEntry(base);
    const b = createAuditEntry(base);
    const c = createAuditEntry({ ...base, action: "memory_change" });
    expect(hashAuditEntry(a)).toBe(hashAuditEntry(b));
    expect(hashAuditEntry(a)).not.toBe(hashAuditEntry(c));
  });
});

describe("AuditStore.record", () => {
  it("record returns a successor store; receiver never mutates", () => {
    const store = createAuditStore();
    const { store: next, entry } = store.record(base);
    expect(entry.action).toBe("conversation_update");
    expect(store.count()).toBe(0);
    expect(next.count()).toBe(1);
  });

  it("bounds retained entries with maxEntries", () => {
    const store = new AuditStore({ maxEntries: 2 });
    let current = store;
    for (let index = 0; index < 3; index += 1) {
      const { store: next } = current.record({ ...base, timestamp: NOW });
      current = next;
    }
    expect(current.count()).toBe(2);
  });

  it("has and find look up entries", () => {
    const store = createAuditStore();
    const { store: next, entry } = store.record(base);
    expect(next.has(entry.id)).toBe(true);
    expect(next.find(entry.id)?.actor).toBe("user-1");
    expect(next.find("nope")).toBeUndefined();
  });
});

describe("query helpers", () => {
  it("forActor / forResource / forAction filter entries", () => {
    const store = createAuditStore();
    const { store: a } = store.record({ ...base, actor: "u1", action: "memory_change" });
    const { store: b } = a.record({ ...base, actor: "u2", action: "tool_execution" });
    expect(b.forActor("u1")).toHaveLength(1);
    expect(b.forResource("conversation")).toHaveLength(2);
    expect(b.forAction("tool_execution")).toHaveLength(1);
    expect(b.forAction("api_mutation")).toHaveLength(0);
  });

  it("forCorrelation filters by correlation id", () => {
    const store = createAuditStore();
    const { store: a } = store.record({
      ...base,
      correlation: { correlationId: "c1" },
    });
    const { store: b } = a.record({
      ...base,
      actor: "u2",
      correlation: { correlationId: "c2" },
    });
    expect(b.forCorrelation("c1")).toHaveLength(1);
    expect(b.forCorrelation("c2")).toHaveLength(1);
    expect(b.forCorrelation("c3")).toHaveLength(0);
  });
});

describe("statistics / summary / references", () => {
  it("auditStatistics counts per action and actor", () => {
    const store = createAuditStore();
    const { store: a } = store.record({ ...base, actor: "u1", action: "memory_change", outcome: "success" });
    const { store: b } = a.record({ ...base, actor: "u1", action: "tool_execution", outcome: "failure" });
    const { store: c } = b.record({ ...base, actor: "u2", action: "tool_execution", outcome: "success" });
    const stats = c.statistics();
    expect(stats.total).toBe(3);
    expect(stats.byAction.memory_change).toBe(1);
    expect(stats.byAction.tool_execution).toBe(2);
    expect(stats.byActor.u1).toBe(2);
    expect(stats.byActor.u2).toBe(1);
    expect(stats.successes).toBe(2);
    expect(stats.failures).toBe(1);
  });

  it("auditSummary captures window, actors and actions", () => {
    const store = createAuditStore();
    const { store: a } = store.record({ ...base, timestamp: NOW, actor: "u2", action: "job_execution" });
    const { store: b } = a.record({ ...base, timestamp: LATER, actor: "u1", action: "memory_change" });
    const summary = b.summary();
    expect(summary.total).toBe(2);
    expect(summary.firstAt).toBe(NOW);
    expect(summary.lastAt).toBe(LATER);
    expect(summary.actors).toEqual(["u1", "u2"]);
    expect(summary.actions).toEqual(["job_execution", "memory_change"]);
    expect(summary.failures).toBe(0);
  });

  it("auditReferences projects lightweight entries", () => {
    const store = createAuditStore();
    const { store: a } = store.record(base);
    const refs = auditReferences(a.entries);
    expect(refs[0]?.actor).toBe("user-1");
    expect(refs[0]?.resource).toBe("conversation");
  });
});

describe("snapshot", () => {
  it("builds a deterministic snapshot at `at`", () => {
    const store = createAuditStore();
    const { store: a } = store.record(base);
    const snapshot = a.snapshot(LATER);
    expect(snapshot.at).toBe(LATER);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.statistics.total).toBe(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

describe("AUDIT_ACTIONS", () => {
  it("covers every audited action", () => {
    const actions: readonly AuditAction[] = [
      "user_action",
      "workflow_execution",
      "tool_execution",
      "ai_action",
      "job_execution",
      "api_mutation",
      "database_change",
      "memory_change",
      "conversation_update",
    ];
    expect(AUDIT_ACTIONS).toEqual(actions);
  });
});
