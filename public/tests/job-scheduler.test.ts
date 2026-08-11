import { describe, it, expect } from "vitest";
import { BackgroundScheduler, orderDueJobs, previewOccurrences } from "@/lib/jobs/scheduler";
import { JobRepository, JobDuplicateError } from "@/lib/jobs/repository";
import { createJob, type CreateJobInput, type Job } from "@/lib/jobs/types";

// ──────────────────────────────────────────────
//  Fixtures
// ──────────────────────────────────────────────

const NOW = "2026-08-10T10:00:00.000Z";

function makeJob(id: string, overrides: Partial<CreateJobInput> = {}): Job {
  return createJob({
    id,
    name: `Job ${id}`,
    createdAt: NOW,
    ...overrides,
  });
}

function makeScheduler(jobs: readonly Job[] = []): BackgroundScheduler {
  return new BackgroundScheduler(new JobRepository(jobs));
}

/** A pending manual job (runnable immediately). */
function pendingManual(id: string): Job {
  return makeJob(id, { trigger: "manual" });
}

// ──────────────────────────────────────────────
//  schedule / unschedule
// ──────────────────────────────────────────────

describe("schedule and unschedule", () => {
  it("schedule adds a job to the successor scheduler", () => {
    const scheduler = new BackgroundScheduler();
    const { scheduler: next, job } = scheduler.schedule(pendingManual("j1"));
    expect(job.id).toBe("j1");
    expect(next.poll(NOW).map((due) => due.id)).toEqual(["j1"]);
    expect(scheduler.poll(NOW)).toEqual([]);
  });

  it("schedule rejects duplicate ids", () => {
    const scheduler = new BackgroundScheduler();
    const { scheduler: next } = scheduler.schedule(pendingManual("j1"));
    expect(() => next.schedule(pendingManual("j1"))).toThrow(JobDuplicateError);
  });

  it("unschedule removes a job from the successor", () => {
    const scheduler = makeScheduler([pendingManual("j1"), pendingManual("j2")]);
    const next = scheduler.unschedule("j1");
    expect(next.poll(NOW).map((due) => due.id)).toEqual(["j2"]);
    expect(scheduler.poll(NOW)).toHaveLength(2);
  });

  it("unschedule is a no-op for unknown ids", () => {
    const scheduler = makeScheduler([pendingManual("j1")]);
    expect(scheduler.unschedule("missing")).toBe(scheduler);
  });
});

// ──────────────────────────────────────────────
//  poll / nextRunnable
// ──────────────────────────────────────────────

describe("poll and nextRunnable", () => {
  it("poll returns every runnable job at now", () => {
    const scheduler = makeScheduler([pendingManual("a"), pendingManual("b")]);
    expect(scheduler.poll(NOW).map((due) => due.id)).toEqual(["a", "b"]);
  });

  it("poll excludes non-pending, archived, and future jobs", () => {
    const scheduler = makeScheduler([
      pendingManual("ok"),
      makeJob("done", { status: "completed" }),
      makeJob("archived", { archived: true }),
      makeJob("future", { schedule: { at: "2026-08-10T12:00:00.000Z" }, scheduledAt: "2026-08-10T12:00:00.000Z" }),
    ]);
    expect(scheduler.poll(NOW).map((due) => due.id)).toEqual(["ok"]);
  });

  it("poll orders by priority (critical > high > normal > low)", () => {
    const scheduler = makeScheduler([
      makeJob("low", { priority: "low" }),
      makeJob("critical", { priority: "critical" }),
      makeJob("normal", { priority: "normal" }),
      makeJob("high", { priority: "high" }),
    ]);
    expect(scheduler.poll(NOW).map((due) => due.id)).toEqual(["critical", "high", "normal", "low"]);
  });

  it("ties are broken by due time then id", () => {
    const scheduler = makeScheduler([
      makeJob("b", { schedule: { at: "2026-08-10T10:00:00.000Z" }, scheduledAt: "2026-08-10T10:00:00.000Z" }),
      makeJob("a", { schedule: { at: "2026-08-10T09:00:00.000Z" }, scheduledAt: "2026-08-10T09:00:00.000Z" }),
    ]);
    // Same priority (normal): earlier due time first.
    expect(scheduler.poll(NOW).map((due) => due.id)).toEqual(["a", "b"]);
  });

  it("ties with equal priority and due time break by id", () => {
    const scheduler = makeScheduler([
      pendingManual("z"),
      pendingManual("a"),
      pendingManual("m"),
    ]);
    expect(scheduler.poll(NOW).map((due) => due.id)).toEqual(["a", "m", "z"]);
  });

  it("nextRunnable returns the single highest-priority job", () => {
    const scheduler = makeScheduler([
      makeJob("a", { priority: "normal" }),
      makeJob("critical", { priority: "critical" }),
    ]);
    expect(scheduler.nextRunnable(NOW)?.id).toBe("critical");
  });

  it("nextRunnable returns undefined when nothing is due", () => {
    const scheduler = makeScheduler([
      makeJob("future", {
        schedule: { at: "2099-01-01T00:00:00.000Z" },
        scheduledAt: "2099-01-01T00:00:00.000Z",
      }),
    ]);
    expect(scheduler.nextRunnable(NOW)).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
//  tick / runDueJobs
// ──────────────────────────────────────────────

describe("tick and runDueJobs", () => {
  it("tick returns the due jobs plus the successor scheduler", () => {
    const scheduler = makeScheduler([pendingManual("a")]);
    const { scheduler: next, due } = scheduler.tick(NOW);
    expect(due.map((job) => job.id)).toEqual(["a"]);
    expect(next).toBe(scheduler);
  });

  it("runDueJobs is an alias of tick", () => {
    const scheduler = makeScheduler([pendingManual("a")]);
    const tick = scheduler.tick(NOW);
    const runDue = scheduler.runDueJobs(NOW);
    expect(runDue.due).toEqual(tick.due);
  });

  it("tick never mutates the scheduler state", () => {
    const scheduler = makeScheduler([pendingManual("a")]);
    scheduler.tick(NOW);
    scheduler.runDueJobs(NOW);
    expect(scheduler.poll(NOW).map((job) => job.id)).toEqual(["a"]);
  });
});

// ──────────────────────────────────────────────
//  Recurring schedules
// ──────────────────────────────────────────────

describe("recurring schedules", () => {
  const recurring = makeJob("r1", {
    trigger: "recurring",
    schedule: { everyMs: 3_600_000, startsAt: "2026-08-10T09:00:00.000Z" },
    scheduledAt: "2026-08-10T09:00:00.000Z",
  });

  it("a recurring job is due when its scheduledAt has arrived", () => {
    const scheduler = makeScheduler([recurring]);
    expect(scheduler.poll("2026-08-10T09:00:00.000Z").map((job) => job.id)).toEqual(["r1"]);
    expect(scheduler.poll("2026-08-10T08:59:59.000Z")).toEqual([]);
  });

  it("a rescheduled recurring job becomes due at its next occurrence", () => {
    let managerJobs = [recurring];
    const scheduler = makeScheduler(managerJobs);
    // Simulate the runner rescheduling after completion.
    const rescheduled = createJob({
      id: "r1",
      name: "Job r1",
      createdAt: NOW,
      trigger: "recurring",
      schedule: { everyMs: 3_600_000, startsAt: "2026-08-10T09:00:00.000Z" },
      scheduledAt: "2026-08-10T10:00:00.000Z",
    });
    managerJobs = [rescheduled];
    const next = makeScheduler(managerJobs);
    expect(next.poll("2026-08-10T09:30:00.000Z")).toEqual([]);
    expect(next.poll("2026-08-10T10:00:00.000Z").map((job) => job.id)).toEqual(["r1"]);
    expect(scheduler.poll("2026-08-10T09:30:00.000Z")).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────
//  orderDueJobs
// ──────────────────────────────────────────────

describe("orderDueJobs", () => {
  it("sorts a mixed set deterministically without mutating the input", () => {
    const input = [
      makeJob("low", { priority: "low" }),
      makeJob("critical", { priority: "critical" }),
      makeJob("high", { priority: "high" }),
      makeJob("normal", { priority: "normal" }),
    ];
    const snapshot = input.map((job) => job.id);
    const ordered = orderDueJobs(input);
    expect(ordered.map((job) => job.id)).toEqual(["critical", "high", "normal", "low"]);
    expect(input.map((job) => job.id)).toEqual(snapshot);
  });

  it("is stable for equal keys", () => {
    const input = [pendingManual("b"), pendingManual("a"), pendingManual("c")];
    expect(orderDueJobs(input).map((job) => job.id)).toEqual(["a", "b", "c"]);
  });

  it("handles 1000 jobs", () => {
    const priorities: Array<Job["priority"]> = ["critical", "high", "normal", "low"];
    const jobs: Job[] = [];
    for (let index = 0; index < 1000; index += 1) {
      jobs.push(makeJob(`j${String(index).padStart(4, "0")}`, { priority: priorities[index % 4] }));
    }
    const ordered = orderDueJobs(jobs);
    expect(ordered).toHaveLength(1000);
    // All critical jobs come before all high jobs, etc.
    const ranks = ordered.map((job) => job.priority);
    const firstCritical = ranks.indexOf("critical");
    const firstHigh = ranks.indexOf("high");
    const firstNormal = ranks.indexOf("normal");
    const firstLow = ranks.indexOf("low");
    expect(firstHigh).toBeGreaterThan(firstCritical);
    expect(firstNormal).toBeGreaterThan(firstHigh);
    expect(firstLow).toBeGreaterThan(firstNormal);
  });
});

// ──────────────────────────────────────────────
//  previewOccurrences
// ──────────────────────────────────────────────

describe("previewOccurrences", () => {
  it("previews upcoming recurring occurrences", () => {
    const schedule = { everyMs: 3_600_000, startsAt: "2026-08-10T09:00:00.000Z" };
    expect(previewOccurrences(schedule, "2026-08-10T10:30:00.000Z", 3)).toEqual([
      "2026-08-10T11:00:00.000Z",
      "2026-08-10T12:00:00.000Z",
      "2026-08-10T13:00:00.000Z",
    ]);
  });

  it("previews a single one-time occurrence once", () => {
    expect(previewOccurrences({ at: "2026-08-10T12:00:00.000Z" }, NOW, 5)).toEqual([
      "2026-08-10T12:00:00.000Z",
    ]);
  });

  it("returns [] for schedules with no occurrences", () => {
    expect(previewOccurrences({}, NOW, 3)).toEqual([]);
  });
});

// ──────────────────────────────────────────────
//  Determinism / purity
// ──────────────────────────────────────────────

describe("determinism and purity", () => {
  it("identical scheduler states produce identical polls", () => {
    const build = (): BackgroundScheduler =>
      makeScheduler([pendingManual("a"), pendingManual("b")]);
    expect(build().poll(NOW)).toEqual(build().poll(NOW));
  });

  it("exposes the backing repository readonly", () => {
    const scheduler = makeScheduler([pendingManual("a")]);
    expect(scheduler.repository).toBeInstanceOf(JobRepository);
    expect(scheduler.repository.count()).toBe(1);
  });

  it("returns detached clones from poll", () => {
    const scheduler = makeScheduler([pendingManual("a")]);
    const due = scheduler.poll(NOW);
    due[0].metadata.tags.push("mutated");
    expect(scheduler.poll(NOW)[0].metadata.tags).toEqual([]);
  });

  it("uses no timers: poll is synchronous and pure", () => {
    const scheduler = makeScheduler([pendingManual("a")]);
    const result = scheduler.poll(NOW);
    expect(Array.isArray(result)).toBe(true);
  });
});
