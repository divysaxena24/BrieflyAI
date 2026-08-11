/**
 * Observability & Monitoring — audit logging (Phase 6C STEP 8).
 *
 * Immutable, successor-based audit trail for user actions, workflow
 * execution, tool execution, AI actions, job execution, API mutations,
 * database changes, memory changes and conversation updates.
 *
 * Every `AuditEntry` records an actor, a resource, a reason, structured
 * metadata, correlation ids and a caller-supplied timestamp. Entries are
 * deep-frozen; the store never mutates.
 */

import { hashString } from "@/lib/hash";

/** The kind of audited action. */
export type AuditAction =
  | "user_action"
  | "workflow_execution"
  | "tool_execution"
  | "ai_action"
  | "job_execution"
  | "api_mutation"
  | "database_change"
  | "memory_change"
  | "conversation_update";

/** Every audit action in a stable canonical order. */
export const AUDIT_ACTIONS: readonly AuditAction[] = Object.freeze([
  "user_action",
  "workflow_execution",
  "tool_execution",
  "ai_action",
  "job_execution",
  "api_mutation",
  "database_change",
  "memory_change",
  "conversation_update",
]);

/** Correlation ids carried on an audit entry. */
export interface AuditCorrelation {
  readonly correlationId?: string;
  readonly requestId?: string;
  readonly workflowId?: string;
  readonly workerId?: string;
  readonly actionId?: string;
  readonly toolId?: string;
  readonly conversationId?: string;
  readonly memoryId?: string;
  readonly jobId?: string;
  readonly digestId?: string;
}

/** A single immutable audit entry. */
export interface AuditEntry {
  /** Stable id: `audit-<hash(actor:resource:action:timestamp)>`. */
  readonly id: string;
  /** Who performed the action (user id, system, worker…). */
  readonly actor: string;
  /** What was acted upon. */
  readonly resource: string;
  readonly resourceId?: string;
  readonly action: AuditAction;
  /** ISO-8601 UTC timestamp (caller-supplied). */
  readonly timestamp: string;
  /** Why the action happened (optional rationale). */
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly correlation?: AuditCorrelation;
  /** Outcome of the action when known. */
  readonly outcome?: "success" | "failure";
}

/** A lightweight projection of an audit entry. */
export interface AuditReference {
  readonly id: string;
  readonly actor: string;
  readonly resource: string;
  readonly action: AuditAction;
  readonly timestamp: string;
  readonly outcome?: "success" | "failure";
}

/** Aggregate statistics over a set of audit entries. */
export interface AuditStatistics {
  readonly total: number;
  readonly byAction: Readonly<Record<AuditAction, number>>;
  readonly byActor: Readonly<Record<string, number>>;
  readonly successes: number;
  readonly failures: number;
}

/** Compact summary of an audit store. */
export interface AuditSummary {
  readonly total: number;
  readonly firstAt?: string;
  readonly lastAt?: string;
  readonly actors: readonly string[];
  readonly actions: readonly AuditAction[];
  readonly failures: number;
}

/** Point-in-time snapshot of an audit store. */
export interface AuditSnapshot {
  readonly at: string;
  readonly entries: readonly AuditEntry[];
  readonly statistics: AuditStatistics;
  readonly summary: AuditSummary;
}

/** Input accepted by {@link createAuditEntry}. */
export interface CreateAuditEntryInput {
  readonly actor: string;
  readonly resource: string;
  readonly resourceId?: string;
  readonly action: AuditAction;
  readonly timestamp: string;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly correlation?: AuditCorrelation;
  readonly outcome?: "success" | "failure";
}

/** Deterministic id for an audit entry. */
export function auditEntryIdFor(input: {
  readonly actor: string;
  readonly resource: string;
  readonly action: AuditAction;
  readonly timestamp: string;
}): string {
  return `audit-${hashString(
    `${input.actor}:${input.resource}:${input.action}:${input.timestamp}`,
  )}`;
}

/** Build a new immutable audit entry. */
export function createAuditEntry(input: CreateAuditEntryInput): AuditEntry {
  return Object.freeze({
    id: auditEntryIdFor(input),
    actor: input.actor,
    resource: input.resource,
    ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
    action: input.action,
    timestamp: input.timestamp,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.metadata !== undefined ? { metadata: Object.freeze({ ...input.metadata }) } : {}),
    ...(input.correlation !== undefined
      ? { correlation: Object.freeze({ ...input.correlation }) }
      : {}),
    ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
  });
}

/** Return a deep, detached copy of an entry (never frozen). */
export function cloneAuditEntry(entry: AuditEntry): AuditEntry {
  return {
    id: entry.id,
    actor: entry.actor,
    resource: entry.resource,
    ...(entry.resourceId !== undefined ? { resourceId: entry.resourceId } : {}),
    action: entry.action,
    timestamp: entry.timestamp,
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    ...(entry.metadata !== undefined ? { metadata: { ...entry.metadata } } : {}),
    ...(entry.correlation !== undefined ? { correlation: { ...entry.correlation } } : {}),
    ...(entry.outcome !== undefined ? { outcome: entry.outcome } : {}),
  };
}

/** Deep-freeze an entry in place and return it (idempotent). */
export function freezeAuditEntry(entry: AuditEntry): AuditEntry {
  if (entry.metadata !== undefined) Object.freeze(entry.metadata);
  if (entry.correlation !== undefined) Object.freeze(entry.correlation);
  return Object.freeze(entry);
}

/** Stable hash of an entry's identity. */
export function hashAuditEntry(entry: AuditEntry): string {
  return hashString(`${entry.id}:${entry.actor}:${entry.action}`);
}

/** Aggregate statistics over a set of entries. */
export function auditStatistics(entries: readonly AuditEntry[]): AuditStatistics {
  const byAction: Record<AuditAction, number> = {
    user_action: 0,
    workflow_execution: 0,
    tool_execution: 0,
    ai_action: 0,
    job_execution: 0,
    api_mutation: 0,
    database_change: 0,
    memory_change: 0,
    conversation_update: 0,
  };
  const byActor: Record<string, number> = {};
  let successes = 0;
  let failures = 0;
  for (const entry of entries) {
    byAction[entry.action] += 1;
    byActor[entry.actor] = (byActor[entry.actor] ?? 0) + 1;
    if (entry.outcome === "success") successes += 1;
    if (entry.outcome === "failure") failures += 1;
  }
  return Object.freeze({
    total: entries.length,
    byAction: Object.freeze(byAction),
    byActor: Object.freeze(byActor),
    successes,
    failures,
  });
}

/** Compact summary of a set of entries. */
export function auditSummary(entries: readonly AuditEntry[]): AuditSummary {
  const first = entries[0];
  const last = entries.length > 0 ? entries[entries.length - 1] : undefined;
  const actors = [...new Set(entries.map((entry) => entry.actor))].sort();
  const actions = [...new Set(entries.map((entry) => entry.action))].sort(
    (a, b) => AUDIT_ACTIONS.indexOf(a) - AUDIT_ACTIONS.indexOf(b),
  );
  const failures = entries.filter((entry) => entry.outcome === "failure").length;
  return Object.freeze({
    total: entries.length,
    ...(first !== undefined ? { firstAt: first.timestamp } : {}),
    ...(last !== undefined ? { lastAt: last.timestamp } : {}),
    actors: Object.freeze(actors),
    actions: Object.freeze(actions),
    failures,
  });
}

/** Project every entry to a lightweight reference. */
export function auditReferences(entries: readonly AuditEntry[]): readonly AuditReference[] {
  return Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        id: entry.id,
        actor: entry.actor,
        resource: entry.resource,
        action: entry.action,
        timestamp: entry.timestamp,
        ...(entry.outcome !== undefined ? { outcome: entry.outcome } : {}),
      }),
    ),
  );
}

/** Options accepted by the {@link AuditStore} constructor. */
export interface AuditStoreOptions {
  readonly entries?: readonly AuditEntry[];
  readonly maxEntries?: number;
}

/**
 * An immutable audit store. `record()` returns a successor store carrying
 * the entry; the receiver is never mutated.
 */
export class AuditStore {
  readonly entries: readonly AuditEntry[];

  private readonly maxEntries: number | undefined;

  constructor(options: AuditStoreOptions = {}) {
    this.entries = Object.freeze([...(options.entries ?? [])].map(cloneAuditEntry));
    this.maxEntries = options.maxEntries;
  }

  /** Build a successor store from partial state. */
  private next(entries: readonly AuditEntry[]): AuditStore {
    return new AuditStore({ entries, maxEntries: this.maxEntries });
  }

  /** The number of retained entries. */
  count(): number {
    return this.entries.length;
  }

  /** Whether an entry with `entryId` is retained. */
  has(entryId: string): boolean {
    return this.entries.some((entry) => entry.id === entryId);
  }

  /** The retained entry with `entryId`, or `undefined`. */
  find(entryId: string): AuditEntry | undefined {
    const entry = this.entries.find((candidate) => candidate.id === entryId);
    return entry === undefined ? undefined : cloneAuditEntry(entry);
  }

  /** Detached copies of every retained entry, oldest first. */
  list(): AuditEntry[] {
    return this.entries.map(cloneAuditEntry);
  }

  /** Record an entry; returns the successor store. */
  record(input: CreateAuditEntryInput): { store: AuditStore; entry: AuditEntry } {
    const entry = createAuditEntry(input);
    let entries = [...this.entries, entry];
    if (this.maxEntries !== undefined && entries.length > this.maxEntries) {
      entries = entries.slice(entries.length - this.maxEntries);
    }
    return { store: this.next(entries), entry: cloneAuditEntry(entry) };
  }

  /** Entries for `actor`. */
  forActor(actor: string): AuditEntry[] {
    return this.entries.filter((entry) => entry.actor === actor).map(cloneAuditEntry);
  }

  /** Entries for `resource`. */
  forResource(resource: string): AuditEntry[] {
    return this.entries.filter((entry) => entry.resource === resource).map(cloneAuditEntry);
  }

  /** Entries for `action`. */
  forAction(action: AuditAction): AuditEntry[] {
    return this.entries.filter((entry) => entry.action === action).map(cloneAuditEntry);
  }

  /** Entries with `correlationId`. */
  forCorrelation(correlationId: string): AuditEntry[] {
    return this.entries
      .filter((entry) => entry.correlation?.correlationId === correlationId)
      .map(cloneAuditEntry);
  }

  /** Aggregate statistics over all retained entries. */
  statistics(): AuditStatistics {
    return auditStatistics(this.entries);
  }

  /** Compact summary of the store. */
  summary(): AuditSummary {
    return auditSummary(this.entries);
  }

  /** Point-in-time snapshot at `at`. */
  snapshot(at: string): AuditSnapshot {
    return Object.freeze({
      at,
      entries: this.list(),
      statistics: this.statistics(),
      summary: this.summary(),
    });
  }
}

/** Build a fresh audit store. */
export function createAuditStore(options: AuditStoreOptions = {}): AuditStore {
  return new AuditStore(options);
}
