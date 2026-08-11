import { describe, it, expect } from "vitest";
import { JobRunner } from "@/lib/jobs/runner";
import { JobExecutor, JobHandlerRegistry, type JobHandler } from "@/lib/jobs/executor";
import { JobManager } from "@/lib/jobs/manager";
import type { CreateJobInput, Job } from "@/lib/jobs/types";

// ──────────────────────────────────────────────
//  Fixtures
// ──────────────────────────────────────────────

const NOW = "2026-08-10T10:00:00.000Z";

function makeJobInput(id: string, overrides: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    id,
    name: `Job ${id}`,
    createdAt: NOW,
    ...overrides,
  };
}

const okHandler: JobHandler = async () => ({ ok: true });
const boomHandler: JobHandler = async () => {
  throw new Error("boom");
};
const hangHandler: JobHandler = () => new Promise<never>(() => undefined);

function makeExecutor(handlers: Record<string, JobHandler>): JobExecutor {
  const registry = new JobHandlerRegistry(
    Object.entries(handlers).map(([id, handler]) => ({ id, handler })),
  );
  return new JobExecutor(registry, {
    sleep: async () => undefined,
    now: () => NOW,
  });
}

function makeRunner(
  jobs: readonly CreateJobInput[],
  handlers: Record<string, JobHandler>,
  options: { stopped?: boolean } = {},
): JobRunner {
  let manager = new JobManager();
  if (jobs.length > 0) manager = manager.bulkRegister(jobs).manager;
  return new JobRunner(manager, makeExecutor(handlers), {
    now: () => NOW,
    stopped: options.stopped,
  });
}

function ids(results: { reference: { jobId: string } }[]): string[] {
  return results.map((result) => result.reference.jobId);
}

// ──────────────────────────────────────────────
//  runOnce
// ──────────────────────────────────────────────

describe("runOnce", () => {
  it("executes every due job exactly once", async () => {
    const runner = makeRunner(
      [makeJobInput("a", { trigger: "manual" }), makeJobInput("b", { trigger: "manual" })],
      { a: okHandler, b: okHandler },
    );
    const { runner: next, summary } = await runner.runOnce(NOW);
    expect(summary.total).toBe(2);
    expect(summary.completed).toBe(2);
    expect(ids(summary.executed)).toEqual(["a", "b"]);
    expect(next.manager.find("a")?.status).toBe("completed");
    expect(next.manager.find("b")?.status).toBe("completed");
  });

  it("executes due jobs in priority order", async () => {
    const runner = makeRunner(
      [
        makeJobInput("low", { trigger: "manual", priority: "low" }),
        makeJobInput("critical", { trigger: "manual", priority: "critical" }),
        makeJobInput("high", { trigger: "manual", priority: "high" }),
      ],
      { low: okHandler, critical: okHandler, high: okHandler },
    );
    const { summary } = await runner.runOnce(NOW);
    expect(ids(summary.executed)).toEqual(["critical", "high", "low"]);
  });

  it("isolates failures: one failing job does not stop the others", async () => {
    const runner = makeRunner(
      [makeJobInput("good"), makeJobInput("bad"), makeJobInput("good2")],
      { good: okHandler, bad: boomHandler, good2: okHandler },
    );
    const { runner: next, summary } = await runner.runOnce(NOW);
    expect(summary.completed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(ids(summary.executed)).toEqual(["bad", "good", "good2"]);
    expect(next.manager.find("bad")?.status).toBe("failed");
    expect(next.manager.find("bad")?.error?.code).toBe("handler_error");
    expect(next.manager.find("good2")?.status).toBe("completed");
  });

  it("records attempts and outputs in results", async () => {
    const runner = makeRunner([makeJobInput("a")], { a: okHandler });
    const { summary } = await runner.runOnce(NOW);
    expect(summary.executed[0].attempt).toBe(1);
    expect(summary.executed[0].output).toEqual({ ok: true });
    expect(summary.executed[0].status).toBe("completed");
  });

  it("does not run future scheduled jobs", async () => {
    const runner = makeRunner(
      [makeJobInput("future", { schedule: { at: "2026-08-10T12:00:00.000Z" }, scheduledAt: "2026-08-10T12:00:00.000Z" })],
      { future: okHandler },
    );
    const { summary } = await runner.runOnce(NOW);
    expect(summary.total).toBe(0);
  });

  it("does not run jobs that are already settled", async () => {
    const runner = makeRunner([makeJobInput("done", { status: "completed" })], { done: okHandler });
    const { summary } = await runner.runOnce(NOW);
    expect(summary.total).toBe(0);
  });
});

// ──────────────────────────────────────────────
//  Recurring jobs
// ──────────────────────────────────────────────

describe("recurring jobs", () => {
  const recurring = makeJobInput("r1", {
    trigger: "recurring",
    schedule: { everyMs: 3_600_000, startsAt: "2026-08-10T09:00:00.000Z" },
    scheduledAt: "2026-08-10T09:00:00.000Z",
  });

  it("completes a recurring job and re-arms it to the next occurrence", async () => {
    const runner = makeRunner([recurring], { r1: okHandler });
    const { runner: next, summary } = await runner.runOnce("2026-08-10T09:30:00.000Z");
    expect(summary.completed).toBe(1);
    const job = next.manager.find("r1") as Job;
    expect(job.status).toBe("pending");
    expect(job.scheduledAt).toBe("2026-08-10T10:00:00.000Z");
    expect(job.attempts).toBe(1);
    // Not due again before the next occurrence.
    const { summary: second } = await next.runOnce("2026-08-10T09:45:00.000Z");
    expect(second.total).toBe(0);
    const { summary: third } = await next.runOnce("2026-08-10T10:00:00.000Z");
    expect(third.total).toBe(1);
  });

  it("leaves a failed recurring job settled (no infinite failure loop)", async () => {
    const runner = makeRunner([recurring], { r1: boomHandler });
    const { runner: next, summary } = await runner.runOnce("2026-08-10T09:30:00.000Z");
    expect(summary.failed).toBe(1);
    const job = next.manager.find("r1") as Job;
    expect(job.status).toBe("failed");
    expect(job.scheduledAt).toBe("2026-08-10T09:00:00.000Z");
    const { summary: second } = await next.runOnce("2026-08-10T10:00:00.000Z");
    expect(second.total).toBe(0);
  });
});

// ──────────────────────────────────────────────
//  runUntilEmpty / run
// ──────────────────────────────────────────────

describe("runUntilEmpty and run", () => {
  it("runs passes until a pass executes nothing", async () => {
    const runner = makeRunner(
      [makeJobInput("a"), makeJobInput("b")],
      { a: okHandler, b: okHandler },
    );
    const { runner: next, summary } = await runner.runUntilEmpty(NOW);
    expect(summary.total).toBe(2);
    expect(next.manager.find("a")?.status).toBe("completed");
  });

  it("run is equivalent to runUntilEmpty", async () => {
    const jobs = [makeJobInput("a"), makeJobInput("b")];
    const first = await makeRunner(jobs, { a: okHandler, b: okHandler }).run(NOW);
    const second = await makeRunner(jobs, { a: okHandler, b: okHandler }).runUntilEmpty(NOW);
    expect(first.summary.total).toBe(second.summary.total);
    expect(first.summary.completed).toBe(2);
  });

  it("terminates with recurring jobs (they reschedule into the future)", async () => {
    const runner = makeRunner(
      [makeJobInput("r1", {
        trigger: "recurring",
        schedule: { everyMs: 3_600_000, startsAt: "2026-08-10T09:00:00.000Z" },
        scheduledAt: "2026-08-10T09:00:00.000Z",
      })],
      { r1: okHandler },
    );
    const { summary } = await runner.runUntilEmpty("2026-08-10T09:30:00.000Z");
    expect(summary.total).toBe(1);
  });

  it("returns an empty summary when nothing is due", async () => {
    const runner = makeRunner([], {});
    const { summary } = await runner.runUntilEmpty(NOW);
    expect(summary.total).toBe(0);
    expect(summary.executed).toEqual([]);
  });
});

// ──────────────────────────────────────────────
//  runScheduled / runManual
// ──────────────────────────────────────────────

describe("runScheduled and runManual", () => {
  const jobs = [
    makeJobInput("manual", { trigger: "manual" }),
    makeJobInput("scheduled", {
      trigger: "scheduled",
      schedule: { at: "2026-08-10T09:00:00.000Z" },
      scheduledAt: "2026-08-10T09:00:00.000Z",
    }),
    makeJobInput("recurring", {
      trigger: "recurring",
      schedule: { everyMs: 3_600_000, startsAt: "2026-08-10T09:00:00.000Z" },
      scheduledAt: "2026-08-10T09:00:00.000Z",
    }),
  ];

  it("runScheduled executes only scheduled/recurring jobs", async () => {
    const runner = makeRunner(jobs, { manual: okHandler, scheduled: okHandler, recurring: okHandler });
    const { summary } = await runner.runScheduled(NOW);
    // Equal priority + equal due time → deterministic id tie-break.
    expect(ids(summary.executed)).toEqual(["recurring", "scheduled"]);
  });

  it("runManual with a reference runs that specific manual job", async () => {
    const runner = makeRunner(jobs, { manual: okHandler, scheduled: okHandler, recurring: okHandler });
    const { summary } = await runner.runManual({ jobId: "manual" }, NOW);
    expect(ids(summary.executed)).toEqual(["manual"]);
  });

  it("runManual accepts a plain job id string", async () => {
    const runner = makeRunner(jobs, { manual: okHandler, scheduled: okHandler, recurring: okHandler });
    const { summary } = await runner.runManual("manual", NOW);
    expect(ids(summary.executed)).toEqual(["manual"]);
  });

  it("runManual without a reference runs every pending manual job", async () => {
    const runner = makeRunner(
      [makeJobInput("m1", { trigger: "manual" }), makeJobInput("m2", { trigger: "manual" }), jobs[1]],
      { m1: okHandler, m2: okHandler, scheduled: okHandler },
    );
    const { summary } = await runner.runManual(undefined, NOW);
    expect(ids(summary.executed)).toEqual(["m1", "m2"]);
  });

  it("runManual skips unknown, non-manual, and settled jobs gracefully", async () => {
    const runner = makeRunner(
      [makeJobInput("done", { status: "completed", trigger: "manual" })],
      { done: okHandler },
    );
    const { summary } = await runner.runManual("missing", NOW);
    expect(summary.total).toBe(0);
    const { summary: second } = await runner.runManual({ jobId: "done" }, NOW);
    expect(second.total).toBe(0);
  });
});

// ──────────────────────────────────────────────
//  stop / resume
// ──────────────────────────────────────────────

describe("stop and resume", () => {
  it("a stopped runner skips execution with an empty summary", async () => {
    const runner = makeRunner([makeJobInput("a")], { a: okHandler }, { stopped: true });
    expect(runner.isStopped()).toBe(true);
    const { runner: next, summary } = await runner.runOnce(NOW);
    expect(summary.total).toBe(0);
    expect(next.manager.find("a")?.status).toBe("pending");
  });

  it("resume returns a running successor", async () => {
    const stopped = makeRunner([makeJobInput("a")], { a: okHandler }, { stopped: true });
    const resumed = stopped.resume();
    expect(stopped.isStopped()).toBe(true);
    expect(resumed.isStopped()).toBe(false);
    const { summary } = await resumed.runOnce(NOW);
    expect(summary.total).toBe(1);
  });

  it("stop never mutates the receiver", async () => {
    const runner = makeRunner([makeJobInput("a")], { a: okHandler });
    const stopped = runner.stop();
    expect(stopped.isStopped()).toBe(true);
    expect(runner.isStopped()).toBe(false);
  });

  it("a stopped successor skips the remaining due jobs in a later pass", async () => {
    const runner = makeRunner(
      [makeJobInput("first"), makeJobInput("second")],
      { first: okHandler, second: okHandler },
    );
    const { runner: afterFirst } = await runner.runManual({ jobId: "first" }, NOW);
    const { summary } = await afterFirst.stop().runOnce(NOW);
    expect(summary.total).toBe(0);
    expect(afterFirst.manager.find("second")?.status).toBe("pending");
  });
});

// ──────────────────────────────────────────────
//  Cancellation through the runner
// ──────────────────────────────────────────────

describe("cancellation through the runner", () => {
  it("forwards the pass signal and records a cancelled outcome", async () => {
    const runner = makeRunner([makeJobInput("j1")], { j1: hangHandler });
    const controller = new AbortController();
    const outcomePromise = runner.runOnce(NOW, controller.signal).then(({ summary }) => summary);
    controller.abort();
    const summary = await outcomePromise;
    expect(summary.cancelled).toBe(1);
    expect(summary.executed[0].status).toBe("cancelled");
    expect(summary.executed[0].error?.code).toBe("cancelled");
  });

  it("a cancelled pass still returns the successor runner with the manager updated", async () => {
    const runner = makeRunner([makeJobInput("j1")], { j1: hangHandler });
    const controller = new AbortController();
    const outcomePromise = runner.runOnce(NOW, controller.signal);
    controller.abort();
    const { runner: next, summary } = await outcomePromise;
    expect(summary.total).toBe(1);
    expect(next.manager.find("j1")?.status).toBe("cancelled");
  });
});

// ──────────────────────────────────────────────
//  Determinism, immutability, scale
// ──────────────────────────────────────────────

describe("determinism, immutability, scale", () => {
  it("identical states produce identical summaries", async () => {
    const run = async (): Promise<unknown> => {
      const runner = makeRunner(
        [makeJobInput("a", { priority: "high" }), makeJobInput("b", { priority: "low" })],
        { a: okHandler, b: okHandler },
      );
      const { summary } = await runner.runOnce(NOW);
      return summary.executed.map((result) => [result.reference.jobId, result.status]);
    };
    expect(await run()).toEqual(await run());
  });

  it("never mutates the receiver runner", async () => {
    const runner = makeRunner([makeJobInput("a")], { a: okHandler });
    await runner.runOnce(NOW);
    expect(runner.manager.find("a")?.status).toBe("pending");
    expect(runner.manager.count()).toBe(1);
  });

  it("exposes the manager readonly", async () => {
    const runner = makeRunner([makeJobInput("a")], { a: okHandler });
    expect(runner.manager).toBeInstanceOf(JobManager);
  });

  it("handles 1000 due jobs in one pass", async () => {
    const jobs: CreateJobInput[] = [];
    const handlers: Record<string, JobHandler> = {};
    for (let index = 0; index < 1000; index += 1) {
      jobs.push(makeJobInput(`j${index}`, { trigger: "manual" }));
      handlers[`j${index}`] = okHandler;
    }
    const runner = makeRunner(jobs, handlers);
    const { summary } = await runner.runOnce(NOW);
    expect(summary.total).toBe(1000);
    expect(summary.completed).toBe(1000);
    expect(summary.failed).toBe(0);
  });
});
