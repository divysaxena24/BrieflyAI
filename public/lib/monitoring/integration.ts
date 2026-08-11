/**
 * Observability & Monitoring — engine integration hooks (Phase 6C STEP 10).
 *
 * Thin, dependency-injected hooks that observe the existing engines without
 * rewriting them. The hooks compose the production MonitoringEngine with:
 *
 * - worker passes (`monitorWorkerRun`) — metrics + logs + spans per pass;
 * - workflow execution (`monitorWorkflowRun`);
 * - action execution (`monitorActionRun`);
 * - job execution (`monitorJobRun`);
 * - tool plan execution (`monitorToolRun`);
 * - database operations (`monitorDatabaseOp`);
 * - persistence operations (`monitorPersistenceOp`);
 * - planner calls (`monitorPlannerRun`);
 * - digest builds (`monitorDigestRun`);
 * - API operations (`monitorApiOp`);
 * - event-driven audit/alert wiring (`wireEventAudit`).
 *
 * No engine logic is reimplemented: each hook wraps an injected runner and
 * records monitoring signals around it. All timestamps are caller-supplied.
 */

import { MonitoringEngine } from "./production";
import type { AppEvent } from "@/lib/events/types";
import { AlertRegistry, createAlertRule } from "./alerts";
import type { AuditAction } from "./audit";

/** Options for a generic observed call. */
export interface MonitorRunOptions {
  /** ISO-8601 UTC timestamp of the run start. */
  readonly now: string;
  /** Optional correlation ids for logs/audit. */
  readonly correlationId?: string;
  /** Optional entity id (worker, job, workflow…). */
  readonly entityId?: string;
  /** Injected millisecond clock for latency/duration. */
  readonly clockMs?: () => number;
  /** ISO-8601 UTC timestamp of the run end (defaults to `now`). */
  readonly finishedAt?: string;
}

/** The structured outcome of an observed run. */
export interface MonitorRunResult<T> {
  readonly result: T;
  /** Observed latency in milliseconds (injected clock). */
  readonly durationMs: number;
}

/** A generic observed runner: runs `work` and records monitoring signals. */
export async function monitorRun<T>(
  engine: MonitoringEngine,
  input: MonitorRunOptions & {
    /** Metric domain. */
    readonly domain: string;
    /** Metric/label names, e.g. "worker.run". */
    readonly name: string;
    /** Log scope, e.g. "workers". */
    readonly scope: string;
    /** Span kind. */
    readonly spanKind: string;
    /** Profile stage. */
    readonly stage: string;
    /** Audit action. */
    readonly auditAction?: AuditAction;
    /** Alert rule type to raise on failure. */
    readonly alertType?: string;
    /** Error → string (defaults to the error message). */
    readonly describeError?: (err: unknown) => string;
  },
  work: () => Promise<T>,
): Promise<MonitorRunResult<T>> {
  const clock = input.clockMs ?? (() => 0);
  const started = clock();
  const correlation = input.correlationId !== undefined ? { correlationId: input.correlationId } : undefined;
  const domain = metricDomainOf(input.domain);
  const finishedAt = input.finishedAt ?? input.now;
  const spanStarted = engine.startSpan({
    kind: spanKindOf(input.spanKind),
    name: input.name,
    startedAt: input.now,
    ...(input.entityId !== undefined
      ? { attributes: { entityId: input.entityId } }
      : {}),
  });
  const recordLatency = (durationMs: number): void => {
    engine.metric({
      domain,
      name: `${input.name}.duration`,
      kind: "latency",
      value: durationMs,
      timestamp: input.now,
      ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
    });
    engine.profile({
      stage: stageOf(input.stage),
      name: input.name,
      durationMs,
      startedAt: input.now,
      ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
    });
  };
  try {
    const result = await work();
    const finished = clock();
    const durationMs = Math.max(0, finished - started);
    engine.finishSpan(spanStarted.span.id, finishedAt);
    recordLatency(durationMs);
    engine.increment(domain, `${input.name}.completed`, input.now, 1, input.entityId);
    if (input.auditAction !== undefined) {
      engine.auditRecord({
        actor: "system",
        resource: input.name,
        ...(input.entityId !== undefined ? { resourceId: input.entityId } : {}),
        action: input.auditAction,
        timestamp: input.now,
        outcome: "success",
        ...(correlation !== undefined ? { correlation } : {}),
      });
    }
    return { result, durationMs };
  } catch (err) {
    const finished = clock();
    const durationMs = Math.max(0, finished - started);
    const message = input.describeError ? input.describeError(err) : err instanceof Error ? err.message : String(err);
    engine.finishSpan(spanStarted.span.id, finishedAt, {
      error: { code: "error", message },
    });
    engine.error(message, input.now, {
      scope: { name: input.scope, ...(input.entityId !== undefined ? { label: input.entityId } : {}) },
      ...(correlation !== undefined ? { correlation } : {}),
    });
    recordLatency(durationMs);
    engine.increment(domain, `${input.name}.failed`, input.now, 1, input.entityId);
    if (input.alertType !== undefined) {
      ensureAlertRule(engine, input.alertType, input.name, input.now);
    }
    if (input.auditAction !== undefined) {
      engine.auditRecord({
        actor: "system",
        resource: input.name,
        ...(input.entityId !== undefined ? { resourceId: input.entityId } : {}),
        action: input.auditAction,
        timestamp: input.now,
        outcome: "failure",
        reason: message,
        ...(correlation !== undefined ? { correlation } : {}),
      });
    }
    throw err;
  }
}

/** Map a free-form domain string onto the metric domain union. */
function metricDomainOf(domain: string): import("./metrics").MetricDomain {
  const known: readonly import("./metrics").MetricDomain[] = [
    "api",
    "workers",
    "jobs",
    "workflows",
    "actions",
    "digest",
    "memory",
    "conversation",
    "database",
    "persistence",
    "tool",
    "planner",
    "context",
    "llm",
    "queue",
    "events",
  ];
  if (known.includes(domain as import("./metrics").MetricDomain)) {
    return domain as import("./metrics").MetricDomain;
  }
  return "context";
}

/** Map a free-form span kind onto the span kind union. */
function spanKindOf(kind: string): import("./tracing").SpanKind {
  const known: readonly import("./tracing").SpanKind[] = [
    "root",
    "api",
    "worker",
    "workflow",
    "job",
    "action",
    "digest",
    "memory",
    "conversation",
    "context",
    "planner",
    "tool",
    "database",
    "persistence",
    "queue",
    "llm",
    "event",
  ];
  if (known.includes(kind as import("./tracing").SpanKind)) {
    return kind as import("./tracing").SpanKind;
  }
  return "root";
}

/** Map a free-form stage string onto the profile stage union. */
function stageOf(stage: string): import("./profiler").ProfileStage {
  const known: readonly import("./profiler").ProfileStage[] = [
    "execution",
    "queue_wait",
    "worker_execution",
    "planner",
    "tool",
    "workflow",
    "database",
    "api",
    "memory_retrieval",
    "rag_retrieval",
    "digest",
    "action",
    "job",
    "conversation",
    "context",
    "llm",
  ];
  if (known.includes(stage as import("./profiler").ProfileStage)) {
    return stage as import("./profiler").ProfileStage;
  }
  return "execution";
}

/** Ensure an alert rule for `type` exists (idempotent). */
function ensureAlertRule(
  engine: MonitoringEngine,
  type: string,
  name: string,
  now: string,
): void {
  const ruleType = alertTypeOf(type);
  if (engine.hasAlertRule(ruleType)) return;
  const rule = createAlertRule({ type: ruleType, severity: "warning" });
  engine.registerAlertRule(rule);
  engine.raiseAlert({
    ruleId: rule.id,
    type: ruleType,
    severity: "warning",
    entityId: name,
    key: `${ruleType}:${name}`,
    message: `${ruleType} detected during ${name}`,
    createdAt: now,
  });
}

/** Map a free-form alert type onto the rule union. */
function alertTypeOf(type: string): import("./alerts").AlertRuleType {
  const known: readonly import("./alerts").AlertRuleType[] = [
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
  if (known.includes(type as import("./alerts").AlertRuleType)) {
    return type as import("./alerts").AlertRuleType;
  }
  return "worker_failure";
}

/** Observe a worker pass; returns the run summary plus monitoring outcomes. */
export async function monitorWorkerRun(
  engine: MonitoringEngine,
  input: MonitorRunOptions,
  run: () => Promise<{ completed: number; failed: number; cancelled: number }>,
): Promise<MonitorRunResult<{ completed: number; failed: number; cancelled: number }>> {
  const outcome = await monitorRun(
    engine,
    {
      ...input,
      domain: "workers",
      name: "worker.run",
      scope: "workers",
      spanKind: "worker",
      stage: "worker_execution",
      auditAction: "user_action",
      alertType: "worker_failure",
    },
    run,
  );
  engine.increment("workers", "worker.pass.completed", input.now, outcome.result.completed);
  engine.increment("workers", "worker.pass.failed", input.now, outcome.result.failed);
  engine.increment("workers", "worker.pass.cancelled", input.now, outcome.result.cancelled);
  return outcome;
}

/** Observe a workflow execution. */
export function monitorWorkflowRun<T>(
  engine: MonitoringEngine,
  input: MonitorRunOptions,
  run: () => Promise<T>,
): Promise<MonitorRunResult<T>> {
  return monitorRun(
    engine,
    {
      ...input,
      domain: "workflows",
      name: "workflow.run",
      scope: "workflows",
      spanKind: "workflow",
      stage: "workflow",
      auditAction: "workflow_execution",
      alertType: "workflow_failure",
    },
    run,
  );
}

/** Observe an action execution. */
export function monitorActionRun<T>(
  engine: MonitoringEngine,
  input: MonitorRunOptions,
  run: () => Promise<T>,
): Promise<MonitorRunResult<T>> {
  return monitorRun(
    engine,
    {
      ...input,
      domain: "actions",
      name: "action.run",
      scope: "actions",
      spanKind: "action",
      stage: "action",
      auditAction: "api_mutation",
      alertType: "action_failure",
    },
    run,
  );
}

/** Observe a job execution. */
export function monitorJobRun<T>(
  engine: MonitoringEngine,
  input: MonitorRunOptions,
  run: () => Promise<T>,
): Promise<MonitorRunResult<T>> {
  return monitorRun(
    engine,
    {
      ...input,
      domain: "jobs",
      name: "job.run",
      scope: "jobs",
      spanKind: "job",
      stage: "job",
      auditAction: "job_execution",
      alertType: "worker_failure",
    },
    run,
  );
}

/** Observe a tool plan execution. */
export function monitorToolRun<T>(
  engine: MonitoringEngine,
  input: MonitorRunOptions,
  run: () => Promise<T>,
): Promise<MonitorRunResult<T>> {
  return monitorRun(
    engine,
    {
      ...input,
      domain: "tool",
      name: "tool.run",
      scope: "tools",
      spanKind: "tool",
      stage: "tool",
      auditAction: "tool_execution",
      alertType: "tool_failure",
    },
    run,
  );
}

/** Observe a database operation. */
export function monitorDatabaseOp<T>(
  engine: MonitoringEngine,
  input: MonitorRunOptions,
  run: () => Promise<T>,
): Promise<MonitorRunResult<T>> {
  return monitorRun(
    engine,
    {
      ...input,
      domain: "database",
      name: "database.op",
      scope: "database",
      spanKind: "database",
      stage: "database",
      auditAction: "database_change",
      alertType: "database_unavailable",
    },
    run,
  );
}

/** Observe a persistence operation. */
export function monitorPersistenceOp<T>(
  engine: MonitoringEngine,
  input: MonitorRunOptions,
  run: () => Promise<T>,
): Promise<MonitorRunResult<T>> {
  return monitorRun(
    engine,
    {
      ...input,
      domain: "persistence",
      name: "persistence.op",
      scope: "persistence",
      spanKind: "persistence",
      stage: "database",
      auditAction: "database_change",
      alertType: "persistence_failure",
    },
    run,
  );
}

/** Observe a planner call. */
export function monitorPlannerRun<T>(
  engine: MonitoringEngine,
  input: MonitorRunOptions,
  run: () => Promise<T>,
): Promise<MonitorRunResult<T>> {
  return monitorRun(
    engine,
    {
      ...input,
      domain: "planner",
      name: "planner.run",
      scope: "planner",
      spanKind: "planner",
      stage: "planner",
      auditAction: "ai_action",
      alertType: "planner_failure",
    },
    run,
  );
}

/** Observe a digest build. */
export function monitorDigestRun<T>(
  engine: MonitoringEngine,
  input: MonitorRunOptions,
  run: () => Promise<T>,
): Promise<MonitorRunResult<T>> {
  return monitorRun(
    engine,
    {
      ...input,
      domain: "digest",
      name: "digest.build",
      scope: "digest",
      spanKind: "digest",
      stage: "digest",
      auditAction: "api_mutation",
      alertType: "digest_failure",
    },
    run,
  );
}

/** Observe an API operation. */
export function monitorApiOp<T>(
  engine: MonitoringEngine,
  input: MonitorRunOptions,
  run: () => Promise<T>,
): Promise<MonitorRunResult<T>> {
  return monitorRun(
    engine,
    {
      ...input,
      domain: "api",
      name: "api.op",
      scope: "api",
      spanKind: "api",
      stage: "api",
      auditAction: "user_action",
      alertType: "worker_failure",
    },
    run,
  );
}

/** Map an application event to an audit action. */
export function auditActionForEvent(event: AppEvent): AuditAction {
  switch (event.type) {
    case "conversation.updated":
      return "conversation_update";
    case "memory.stored":
      return "memory_change";
    case "digest.published":
      return "api_mutation";
    case "workflow.triggered":
      return "workflow_execution";
    case "job.completed":
      return "job_execution";
    case "action.completed":
      return "api_mutation";
    default:
      return "user_action";
  }
}

/**
 * Wire an application event into audit + metrics on the monitoring engine.
 * The engine updates its internal collectors and is returned (the event
 * itself is never mutated).
 */
export function observeAppEvent(
  engine: MonitoringEngine,
  event: AppEvent,
): MonitoringEngine {
  const action = auditActionForEvent(event);
  engine.auditRecord({
    actor: "system",
    resource: event.type,
    resourceId: event.entityId,
    action,
    timestamp: event.now,
    outcome: "success",
    correlation: { correlationId: event.id },
  });
  engine.increment("events", "event.processed", event.now, 1, event.entityId);
  return engine;
}

/** The alert registry used by the integration (re-exported for tests). */
export type { AlertRegistry };
