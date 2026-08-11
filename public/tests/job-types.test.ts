import { describe, it, expect } from "vitest";
import {
  createJob,
  cloneJob,
  freezeJob,
  createExecution,
  touchJob,
  isJobRunnable,
  isDue,
  estimateExecutionCost,
  createJobSummary,
  createJobHistory,
  createJobReference,
  nextOccurrence,
  isOneTimeSchedule,
  isRecurringSchedule,
  hashString,
  PRIORITY_RANK,
  PRIORITY_COST,
  DEFAULT_JOB_STATUS,
  DEFAULT_JOB_PRIORITY,
  DEFAULT_JOB_TRIGGER,
  DEFAULT_JOB_MAX_ATTEMPTS,
  type CreateJobInput,
  type Job,
} from "@/lib/jobs/types";

// ──────────────────────────────────────────────
//  Fixtures
// ──────────────────────────────────────────────

const NOW = "2026-08-10T10:00:00.000Z";

function makeJobInput(overrides: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    name: "Digest job",
    createdAt: NOW,
    ...overrides,
  };
}

function makeJob(overrides: Partial<CreateJobInput> = {}): Job {
  return createJob(makeJobInput(overrides));
}

// ──────────────────────────────────────────────
//  createJob
// ──────────────────────────────────────────────

describe("createJob", () => {
  it("applies defaults: pending, normal, manual, maxAttempts 1, archived false", () => {
    const job = makeJob({ id: "j1" });
    expect(job.id).toBe("j1");
    expect(job.name).toBe("Digest job");
    expect(job.status).toBe(DEFAULT_JOB_STATUS);
    expect(job.priority).toBe(DEFAULT_JOB_PRIORITY);
    expect(job.trigger).toBe(DEFAULT_JOB_TRIGGER);
    expect(job.maxAttempts).toBe(DEFAULT_JOB_MAX_ATTEMPTS);
    expect(job.attempts).toBe(0);
    expect(job.archived).toBe(false);
    expect(job.createdAt).toBe(NOW);
    expect(job.metadata.tags).toEqual([]);
    expect(job.executions).toEqual([]);
  });

  it("derives a deterministic id from the job's own contents", () => {
    const first = makeJob();
    const second = makeJob();
    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^job-[0-9a-f]{8}$/);
  });

  it("derives different ids when contents differ", () => {
    expect(makeJob({ name: "A" }).id).not.toBe(makeJob({ name: "B" }).id);
    expect(makeJob({ priority: "high" }).id).not.toBe(makeJob({ priority: "low" }).id);
  });

  it("honors an explicit id", () => {
    expect(makeJob({ id: "explicit-1" }).id).toBe("explicit-1");
  });

  it("copies tags instead of referencing them", () => {
    const tags = ["a", "b"];
    const job = makeJob({ id: "j1", metadata: { tags } });
    tags.push("c");
    expect(job.metadata.tags).toEqual(["a", "b"]);
  });

  it("copies executions instead of referencing them", () => {
    const execution = createExecution({
      jobId: "j1",
      attempt: 1,
      status: "running",
      startedAt: NOW,
    });
    const executions = [execution];
    const job = makeJob({ id: "j1", executions });
    executions.push(execution);
    expect(job.executions).toHaveLength(1);
  });

  it("defaults a recurring schedule's startsAt to createdAt", () => {
    const job = makeJob({ id: "j1", schedule: { everyMs: 1000 } });
    expect(job.schedule?.startsAt).toBe(NOW);
    expect(job.schedule?.everyMs).toBe(1000);
  });

  it("preserves an explicit recurring startsAt", () => {
    const job = makeJob({
      id: "j1",
      schedule: { everyMs: 1000, startsAt: "2026-09-01T00:00:00.000Z" },
    });
    expect(job.schedule?.startsAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("keeps one-time schedules as-is", () => {
    const job = makeJob({ id: "j1", schedule: { at: "2026-09-01T00:00:00.000Z" } });
    expect(job.schedule).toEqual({ at: "2026-09-01T00:00:00.000Z" });
  });

  it("copies metadata fields", () => {
    const job = makeJob({
      id: "j1",
      metadata: { tags: ["x"], timeoutMs: 50, retryDelayMs: 10, costUnits: 9 },
    });
    expect(job.metadata).toEqual({ tags: ["x"], timeoutMs: 50, retryDelayMs: 10, costUnits: 9 });
  });

  it("copies error and result records", () => {
    const error = { code: "boom", message: "boom" };
    const result = { success: true, output: { a: 1 }, message: "ok", durationMs: 5 };
    const job = makeJob({ id: "j1", error, result });
    error.code = "changed";
    result.success = false;
    expect(job.error).toEqual({ code: "boom", message: "boom" });
    expect(job.result).toEqual({ success: true, output: { a: 1 }, message: "ok", durationMs: 5 });
  });
});

// ──────────────────────────────────────────────
//  cloneJob / freezeJob
// ──────────────────────────────────────────────

describe("cloneJob and freezeJob", () => {
  it("cloneJob returns a deep detached copy", () => {
    const job = makeJob({
      id: "j1",
      schedule: { everyMs: 1000, startsAt: NOW },
      metadata: { tags: ["t"], costUnits: 3 },
      executions: [
        createExecution({ jobId: "j1", attempt: 1, status: "completed", startedAt: NOW }),
      ],
    });
    const clone = cloneJob(job);
    expect(clone).toEqual(job);
    expect(clone).not.toBe(job);
    expect(clone.metadata).not.toBe(job.metadata);
    expect(clone.metadata.tags).not.toBe(job.metadata.tags);
    expect(clone.schedule).not.toBe(job.schedule);
    expect(clone.executions).not.toBe(job.executions);
    expect(clone.executions[0]).not.toBe(job.executions[0]);
  });

  it("mutating the clone never affects the source", () => {
    const job = makeJob({ id: "j1", metadata: { tags: ["t"] } });
    const clone = cloneJob(job);
    (clone as unknown as { name: string }).name = "Renamed";
    clone.metadata.tags.push("extra");
    clone.executions.push(
      createExecution({ jobId: "j1", attempt: 1, status: "running", startedAt: NOW }),
    );
    expect(job.name).toBe("Digest job");
    expect(job.metadata.tags).toEqual(["t"]);
    expect(job.executions).toHaveLength(0);
  });

  it("freezeJob deep-freezes the job and all nested structures", () => {
    const job = makeJob({
      id: "j1",
      schedule: { everyMs: 1000 },
      metadata: { tags: ["t"] },
      executions: [
        createExecution({ jobId: "j1", attempt: 1, status: "running", startedAt: NOW }),
      ],
    });
    const frozen = freezeJob(job);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.metadata)).toBe(true);
    expect(Object.isFrozen(frozen.metadata.tags)).toBe(true);
    expect(Object.isFrozen(frozen.schedule)).toBe(true);
    expect(Object.isFrozen(frozen.executions)).toBe(true);
    expect(Object.isFrozen(frozen.executions[0])).toBe(true);
  });

  it("freezeJob is idempotent", () => {
    const job = freezeJob(makeJob({ id: "j1" }));
    expect(freezeJob(job)).toBe(job);
  });
});

// ──────────────────────────────────────────────
//  createExecution
// ──────────────────────────────────────────────

describe("createExecution", () => {
  it("derives a deterministic id", () => {
    const input = { jobId: "j1", attempt: 1, status: "running" as const, startedAt: NOW };
    const first = createExecution(input);
    const second = createExecution(input);
    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^exec-[0-9a-f]{8}$/);
  });

  it("honors an explicit id", () => {
    expect(createExecution({ id: "e1", jobId: "j1", attempt: 1, status: "running", startedAt: NOW }).id).toBe("e1");
  });

  it("copies error and result records", () => {
    const error = { code: "timeout", message: "slow" };
    const execution = createExecution({
      jobId: "j1",
      attempt: 1,
      status: "failed",
      startedAt: NOW,
      finishedAt: NOW,
      error,
      durationMs: 42,
    });
    error.message = "changed";
    expect(execution.error).toEqual({ code: "timeout", message: "slow" });
    expect(execution.durationMs).toBe(42);
    expect(execution.finishedAt).toBe(NOW);
  });
});

// ──────────────────────────────────────────────
//  touchJob
// ──────────────────────────────────────────────

describe("touchJob", () => {
  it("applies a partial patch and preserves the rest", () => {
    const job = makeJob({ id: "j1", priority: "high" });
    const next = touchJob(job, { status: "running", priority: "critical" });
    expect(next.status).toBe("running");
    expect(next.priority).toBe("critical");
    expect(next.name).toBe("Digest job");
    expect(next.id).toBe("j1");
    expect(job.status).toBe("pending");
  });

  it("clears optional fields with null", () => {
    const job = makeJob({ id: "j1", scheduledAt: NOW, startedAt: NOW, error: { code: "x", message: "y" } });
    const next = touchJob(job, { scheduledAt: null, startedAt: null, error: null });
    expect(next.scheduledAt).toBeUndefined();
    expect(next.startedAt).toBeUndefined();
    expect(next.error).toBeUndefined();
  });

  it("preserves optional fields when not patched", () => {
    const job = makeJob({ id: "j1", scheduledAt: NOW, completedAt: NOW });
    const next = touchJob(job, { status: "completed" });
    expect(next.scheduledAt).toBe(NOW);
    expect(next.completedAt).toBe(NOW);
  });

  it("replaces executions with a copied array", () => {
    const execution = createExecution({ jobId: "j1", attempt: 1, status: "running", startedAt: NOW });
    const job = makeJob({ id: "j1" });
    const next = touchJob(job, { executions: [execution] });
    expect(next.executions).toHaveLength(1);
    next.executions.push(execution);
    expect(job.executions).toHaveLength(0);
  });

  it("clears metadata optional fields with null", () => {
    const job = makeJob({ id: "j1", metadata: { timeoutMs: 10, retryDelayMs: 5, costUnits: 2 } });
    const next = touchJob(job, { timeoutMs: null, retryDelayMs: null, costUnits: null });
    expect(next.metadata.timeoutMs).toBeUndefined();
    expect(next.metadata.retryDelayMs).toBeUndefined();
    expect(next.metadata.costUnits).toBeUndefined();
  });

  it("never mutates the input", () => {
    const job = makeJob({ id: "j1" });
    touchJob(job, { status: "running", name: "X" });
    expect(job.status).toBe("pending");
    expect(job.name).toBe("Digest job");
  });
});

// ──────────────────────────────────────────────
//  isDue / isJobRunnable
// ──────────────────────────────────────────────

describe("isDue and isJobRunnable", () => {
  it("a pending job without a schedule is due", () => {
    expect(isDue(makeJob({ id: "j1" }), NOW)).toBe(true);
    expect(isJobRunnable(makeJob({ id: "j1" }), NOW)).toBe(true);
  });

  it("a pending one-time job is due when its scheduledAt is at or before now", () => {
    const job = makeJob({ id: "j1", schedule: { at: "2026-08-10T09:00:00.000Z" }, scheduledAt: "2026-08-10T09:00:00.000Z" });
    expect(isDue(job, "2026-08-10T09:00:00.000Z")).toBe(true);
    expect(isDue(job, "2026-08-10T10:00:00.000Z")).toBe(true);
  });

  it("a pending one-time job is not due before its scheduledAt", () => {
    const job = makeJob({ id: "j1", schedule: { at: "2026-08-10T11:00:00.000Z" }, scheduledAt: "2026-08-10T11:00:00.000Z" });
    expect(isDue(job, "2026-08-10T10:00:00.000Z")).toBe(false);
  });

  it("non-pending jobs are never due", () => {
    for (const status of ["running", "completed", "failed", "cancelled", "skipped"] as const) {
      expect(isDue(makeJob({ id: "j1", status }), NOW)).toBe(false);
    }
  });

  it("archived jobs are never due", () => {
    expect(isDue(makeJob({ id: "j1", archived: true }), NOW)).toBe(false);
  });

  it("a scheduled job without scheduledAt is never due", () => {
    expect(isDue(makeJob({ id: "j1", schedule: { everyMs: 1000 } }), NOW)).toBe(false);
  });

  it("isJobRunnable is identical to isDue", () => {
    const job = makeJob({ id: "j1", schedule: { at: "2026-08-10T11:00:00.000Z" }, scheduledAt: "2026-08-10T11:00:00.000Z" });
    expect(isJobRunnable(job, "2026-08-10T10:00:00.000Z")).toBe(isDue(job, "2026-08-10T10:00:00.000Z"));
  });
});

// ──────────────────────────────────────────────
//  estimateExecutionCost
// ──────────────────────────────────────────────

describe("estimateExecutionCost", () => {
  it("uses the priority base cost by default", () => {
    expect(estimateExecutionCost(makeJob({ id: "j1", priority: "low" }))).toBe(PRIORITY_COST.low);
    expect(estimateExecutionCost(makeJob({ id: "j1", priority: "normal" }))).toBe(PRIORITY_COST.normal);
    expect(estimateExecutionCost(makeJob({ id: "j1", priority: "high" }))).toBe(PRIORITY_COST.high);
    expect(estimateExecutionCost(makeJob({ id: "j1", priority: "critical" }))).toBe(PRIORITY_COST.critical);
  });

  it("prefers explicit costUnits", () => {
    expect(estimateExecutionCost(makeJob({ id: "j1", priority: "low", metadata: { costUnits: 50 } }))).toBe(50);
  });

  it("is deterministic", () => {
    const job = makeJob({ id: "j1", priority: "high" });
    expect(estimateExecutionCost(job)).toBe(estimateExecutionCost(job));
  });
});

// ──────────────────────────────────────────────
//  Schedule helpers
// ──────────────────────────────────────────────

describe("schedule helpers", () => {
  it("distinguishes one-time and recurring schedules", () => {
    expect(isOneTimeSchedule({ at: NOW })).toBe(true);
    expect(isOneTimeSchedule({ everyMs: 1000 })).toBe(false);
    expect(isRecurringSchedule({ everyMs: 1000 })).toBe(true);
    expect(isRecurringSchedule({ at: NOW })).toBe(false);
    expect(isRecurringSchedule({ everyMs: 0 })).toBe(false);
    expect(isRecurringSchedule({})).toBe(false);
  });

  it("nextOccurrence returns the one-time timestamp", () => {
    expect(nextOccurrence({ at: "2026-09-01T00:00:00.000Z" }, NOW)).toBe("2026-09-01T00:00:00.000Z");
  });

  it("nextOccurrence returns startsAt when after precedes it", () => {
    const schedule = { everyMs: 1000, startsAt: "2026-09-01T00:00:00.000Z" };
    expect(nextOccurrence(schedule, "2026-08-01T00:00:00.000Z")).toBe("2026-09-01T00:00:00.000Z");
  });

  it("nextOccurrence computes the next interval strictly after `after`", () => {
    const schedule = { everyMs: 1000, startsAt: "2026-08-10T10:00:00.000Z" };
    expect(nextOccurrence(schedule, "2026-08-10T10:00:00.000Z")).toBe("2026-08-10T10:00:01.000Z");
    expect(nextOccurrence(schedule, "2026-08-10T10:00:00.500Z")).toBe("2026-08-10T10:00:01.000Z");
    expect(nextOccurrence(schedule, "2026-08-10T10:00:01.000Z")).toBe("2026-08-10T10:00:02.000Z");
  });

  it("nextOccurrence is deterministic", () => {
    const schedule = { everyMs: 3_600_000, startsAt: "2026-08-10T00:00:00.000Z" };
    expect(nextOccurrence(schedule, "2026-08-10T10:30:00.000Z")).toBe(nextOccurrence(schedule, "2026-08-10T10:30:00.000Z"));
    expect(nextOccurrence(schedule, "2026-08-10T10:30:00.000Z")).toBe("2026-08-10T11:00:00.000Z");
  });

  it("nextOccurrence returns undefined for a schedule with no occurrences", () => {
    expect(nextOccurrence({}, NOW)).toBeUndefined();
    expect(nextOccurrence({ everyMs: 0, startsAt: NOW }, NOW)).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
//  Projections and references
// ──────────────────────────────────────────────

describe("projections and references", () => {
  it("createJobSummary projects the core fields with cost estimate", () => {
    const job = makeJob({ id: "j1", priority: "critical", attempts: 2, maxAttempts: 3, scheduledAt: NOW });
    const summary = createJobSummary(job);
    expect(summary).toEqual({
      id: "j1",
      name: "Digest job",
      status: "pending",
      priority: "critical",
      trigger: "manual",
      createdAt: NOW,
      scheduledAt: NOW,
      attempts: 2,
      maxAttempts: 3,
      archived: false,
      costEstimate: PRIORITY_COST.critical,
    });
  });

  it("createJobHistory exposes detached executions", () => {
    const execution = createExecution({ jobId: "j1", attempt: 1, status: "running", startedAt: NOW });
    const job = makeJob({ id: "j1", executions: [execution] });
    const history = createJobHistory(job);
    expect(history.jobId).toBe("j1");
    expect(history.executions).toHaveLength(1);
    history.executions.pop();
    expect(job.executions).toHaveLength(1);
  });

  it("createJobReference carries the job id and trigger", () => {
    const job = makeJob({ id: "j1", trigger: "recurring" });
    expect(createJobReference(job)).toEqual({ jobId: "j1", trigger: "recurring" });
  });
});

// ──────────────────────────────────────────────
//  Determinism and constants
// ──────────────────────────────────────────────

describe("determinism and constants", () => {
  it("hashString is deterministic and collision-free for distinct inputs", () => {
    expect(hashString("a")).toBe(hashString("a"));
    expect(hashString("a")).not.toBe(hashString("b"));
    expect(hashString("")).toBe("811c9dc5");
  });

  it("priority ranks order critical > high > normal > low", () => {
    expect(PRIORITY_RANK.critical).toBeGreaterThan(PRIORITY_RANK.high);
    expect(PRIORITY_RANK.high).toBeGreaterThan(PRIORITY_RANK.normal);
    expect(PRIORITY_RANK.normal).toBeGreaterThan(PRIORITY_RANK.low);
  });

  it("identical inputs produce deep-equal jobs", () => {
    const first = makeJob({ id: "j1", schedule: { everyMs: 1000 }, metadata: { tags: ["x"] } });
    const second = makeJob({ id: "j1", schedule: { everyMs: 1000 }, metadata: { tags: ["x"] } });
    expect(first).toEqual(second);
  });
});
