import { describe, it, expect } from "vitest";
import { JobManager } from "@/lib/jobs/manager";
import { JobRepository, JobNotFoundError } from "@/lib/jobs/repository";
import { BackgroundScheduler } from "@/lib/jobs/scheduler";
import { JobExecutor, JobHandlerRegistry, type JobHandler } from "@/lib/jobs/executor";
import { JobRunner, type RunSummary } from "@/lib/jobs/runner";
import {
  createProductionJobEngine,
  runBackgroundJobs,
  DIGEST_JOB_ID,
  type BackgroundDigest,
} from "@/lib/jobs/production";
import { createJob, cloneJob, type CreateJobInput, type Job } from "@/lib/jobs/types";
import type { ContextEngine } from "@/lib/context/engine";

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

const okHandler: JobHandler = async (context) => ({ id: context.job.id });
const boomHandler: JobHandler = async () => {
  throw new Error("boom");
};

function makeRunner(
  jobs: readonly CreateJobInput[],
  handlers: Record<string, JobHandler>,
): JobRunner {
  let manager = new JobManager();
  if (jobs.length > 0) manager = manager.bulkRegister(jobs).manager;
  const registry = new JobHandlerRegistry(
    Object.entries(handlers).map(([id, handler]) => ({ id, handler })),
  );
  return new JobRunner(manager, new JobExecutor(registry, { sleep: async () => undefined, now: () => NOW }), { now: () => NOW });
}

function ids(summary: RunSummary): string[] {
  return summary.executed.map((result) => result.reference.jobId);
}

/** Deterministic stub Context Engine for production-engine E2E tests. */
const stubContextEngine = {
  buildPrompt: async (): Promise<string> => "MOCK CONTEXT",
} as unknown as ContextEngine;

// ──────────────────────────────────────────────
//  Full framework flow: create → schedule → run
// ──────────────────────────────────────────────

describe("full framework flow", () => {
  it("creates, schedules, and executes jobs end to end", async () => {
    let manager = new JobManager();
    manager = manager.scheduleJob(
      makeJobInput("hourly", {
        trigger: "recurring",
        schedule: { everyMs: 3_600_000, startsAt: "2026-08-10T09:00:00.000Z" },
        scheduledAt: "2026-08-10T09:00:00.000Z",
      }),
    ).manager;
    manager = manager.registerJob(makeJobInput("onetime", {
      trigger: "scheduled",
      schedule: { at: "2026-08-10T09:00:00.000Z" },
      scheduledAt: "2026-08-10T09:00:00.000Z",
    })).manager;
    manager = manager.registerJob(makeJobInput("manual-job", { trigger: "manual" })).manager;

    const scheduler = new BackgroundScheduler(manager.repository);
    expect(scheduler.poll("2026-08-10T09:00:00.000Z").map((job) => job.id)).toEqual([
      "hourly",
      "onetime",
      "manual-job",
    ]);

    const registry = new JobHandlerRegistry(
      Object.entries({ hourly: okHandler, onetime: okHandler, "manual-job": okHandler }).map(
        ([id, handler]) => ({ id, handler }),
      ),
    );
    const executor = new JobExecutor(registry, { sleep: async () => undefined, now: () => NOW });
    const runner = new JobRunner(manager, executor, { now: () => NOW });
    const { summary } = await runner.run("2026-08-10T09:00:00.000Z");
    expect(summary.total).toBe(3);
    expect(summary.completed).toBe(3);
  });
});

// ──────────────────────────────────────────────
//  Priority execution
// ──────────────────────────────────────────────

describe("priority execution", () => {
  it("runs critical jobs before high before normal before low", async () => {
    const runner = makeRunner(
      [
        makeJobInput("low", { priority: "low" }),
        makeJobInput("critical-1", { priority: "critical" }),
        makeJobInput("normal", { priority: "normal" }),
        makeJobInput("high", { priority: "high" }),
        makeJobInput("critical-2", { priority: "critical" }),
      ],
      { low: okHandler, "critical-1": okHandler, normal: okHandler, high: okHandler, "critical-2": okHandler },
    );
    const { summary } = await runner.run(NOW);
    expect(ids(summary)).toEqual(["critical-1", "critical-2", "high", "normal", "low"]);
  });

  it("ties within a priority run in deterministic id order", async () => {
    const runner = makeRunner(
      [makeJobInput("z", { priority: "high" }), makeJobInput("a", { priority: "high" })],
      { z: okHandler, a: okHandler },
    );
    const { summary } = await runner.run(NOW);
    expect(ids(summary)).toEqual(["a", "z"]);
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

  it("runs, reschedules, and runs again at the next occurrence", async () => {
    const runner = makeRunner([recurring], { r1: okHandler });
    const { runner: afterFirst, summary: first } = await runner.run("2026-08-10T09:30:00.000Z");
    expect(first.total).toBe(1);
    const job = afterFirst.manager.find("r1") as Job;
    expect(job.scheduledAt).toBe("2026-08-10T10:00:00.000Z");

    const { summary: second } = await afterFirst.run("2026-08-10T10:00:00.000Z");
    expect(second.total).toBe(1);
    expect((afterFirst.manager.find("r1") as Job).attempts).toBe(1);
    expect((afterFirst.manager.find("r1") as Job).executions).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────
//  Manual jobs
// ──────────────────────────────────────────────

describe("manual jobs", () => {
  it("runs a specific manual job on demand", async () => {
    const runner = makeRunner([makeJobInput("m1", { trigger: "manual" })], { m1: okHandler });
    const { summary } = await runner.runManual({ jobId: "m1" }, NOW);
    expect(summary.total).toBe(1);
    expect(summary.executed[0].status).toBe("completed");
  });

  it("leaves the job pending for future runs after a completed manual run", async () => {
    const runner = makeRunner([makeJobInput("m1", { trigger: "manual" })], { m1: okHandler });
    const { runner: next } = await runner.runManual({ jobId: "m1" }, NOW);
    expect(next.manager.find("m1")?.status).toBe("completed");
    const { summary } = await next.runManual({ jobId: "m1" }, NOW);
    expect(summary.total).toBe(0);
  });
});

// ──────────────────────────────────────────────
//  Cancellation, retries, timeout
// ──────────────────────────────────────────────

describe("cancellation, retries, timeout", () => {
  it("cancels a runnable pass via the abort signal", async () => {
    const hang: JobHandler = () => new Promise<never>(() => undefined);
    const runner = makeRunner([makeJobInput("h")], { h: hang });
    const controller = new AbortController();
    const outcomePromise = runner.run(NOW, controller.signal);
    controller.abort();
    const { summary } = await outcomePromise;
    expect(summary.cancelled).toBe(1);
  });

  it("retries a failing job until it succeeds (configured retries)", async () => {
    let calls = 0;
    const flaky: JobHandler = async () => {
      calls += 1;
      if (calls < 3) throw new Error("flaky");
      return "ok";
    };
    const runner = makeRunner([makeJobInput("f", { maxAttempts: 3 })], { f: flaky });
    const { runner: next, summary } = await runner.run(NOW);
    expect(summary.completed).toBe(1);
    expect(next.manager.find("f")?.status).toBe("completed");
    expect(calls).toBe(3);
  });

  it("fails after exhausting retries", async () => {
    let calls = 0;
    const failing: JobHandler = async () => {
      calls += 1;
      throw new Error("nope");
    };
    const runner = makeRunner([makeJobInput("f", { maxAttempts: 2 })], { f: failing });
    const { runner: next, summary } = await runner.run(NOW);
    expect(summary.failed).toBe(1);
    expect(next.manager.find("f")?.error?.code).toBe("handler_error");
    expect(calls).toBe(2);
  });

  it("times out a hanging job when a timeout is configured", async () => {
    const hang: JobHandler = () => new Promise<never>(() => undefined);
    const runner = makeRunner(
      [makeJobInput("slow", { metadata: { timeoutMs: 5 } })],
      { slow: hang },
    );
    const { runner: next, summary } = await runner.run(NOW);
    expect(summary.failed).toBe(1);
    expect(next.manager.find("slow")?.error?.code).toBe("timeout");
  });
});

// ──────────────────────────────────────────────
//  Failure isolation
// ──────────────────────────────────────────────

describe("failure isolation", () => {
  it("a failing job never stops the others in the same pass", async () => {
    const runner = makeRunner(
      [
        makeJobInput("a", { priority: "high" }),
        makeJobInput("bad", { priority: "high" }),
        makeJobInput("b", { priority: "high" }),
        makeJobInput("c", { priority: "low" }),
      ],
      { a: okHandler, bad: boomHandler, b: okHandler, c: okHandler },
    );
    const { summary } = await runner.run(NOW);
    expect(summary.total).toBe(4);
    expect(summary.failed).toBe(1);
    expect(summary.completed).toBe(3);
  });
});

// ──────────────────────────────────────────────
//  1000 jobs
// ──────────────────────────────────────────────

describe("1000 jobs", () => {
  it("creates and runs 1000 jobs with correct aggregation", async () => {
    const jobs: CreateJobInput[] = [];
    const handlers: Record<string, JobHandler> = {};
    for (let index = 0; index < 1000; index += 1) {
      const id = `j${String(index).padStart(4, "0")}`;
      jobs.push(makeJobInput(id, { priority: index % 2 === 0 ? "critical" : "low" }));
      handlers[id] = okHandler;
    }
    const runner = makeRunner(jobs, handlers);
    const { summary } = await runner.run(NOW);
    expect(summary.total).toBe(1000);
    expect(summary.completed).toBe(1000);
    expect(summary.failed).toBe(0);
    expect(summary.executed[0].reference.jobId).toBe("j0000");
  });

  it("sorts 1000 jobs into priority groups deterministically", async () => {
    const jobs: CreateJobInput[] = [];
    for (let index = 0; index < 1000; index += 1) {
      jobs.push(makeJobInput(`j${index}`, { priority: index % 4 === 0 ? "critical" : "normal" }));
    }
    const first = new BackgroundScheduler(new JobRepository(jobs.map((input) => createJob(input)))).poll(NOW);
    const second = new BackgroundScheduler(new JobRepository(jobs.map((input) => createJob(input)))).poll(NOW);
    expect(first.map((job) => job.id)).toEqual(second.map((job) => job.id));
    expect(first).toHaveLength(1000);
  });
});

// ──────────────────────────────────────────────
//  Determinism
// ──────────────────────────────────────────────

describe("determinism", () => {
  it("identical inputs produce identical execution sequences", async () => {
    const build = (): JobRunner =>
      makeRunner(
        [makeJobInput("a", { priority: "high" }), makeJobInput("b", { priority: "low" })],
        { a: okHandler, b: okHandler },
      );
    const first = await build().run(NOW);
    const second = await build().run(NOW);
    expect(first.summary).toEqual(second.summary);
  });

  it("the production engine produces identical digests for identical states", async () => {
    const build = () =>
      createProductionJobEngine({ contextEngine: stubContextEngine, now: () => NOW });
    const first = await build().run({ now: NOW });
    const second = await build().run({ now: NOW });
    const firstDigest = first.executed[0].output as BackgroundDigest;
    const secondDigest = second.executed[0].output as BackgroundDigest;
    expect(firstDigest).toEqual(secondDigest);
  });
});

// ──────────────────────────────────────────────
//  Immutability and repository detachment
// ──────────────────────────────────────────────

describe("immutability and detachment", () => {
  it("keeps repositories detached across runner passes", async () => {
    const runner = makeRunner([makeJobInput("a")], { a: okHandler });
    const repositoryBefore = runner.manager.repository;
    const { runner: next } = await runner.run(NOW);
    expect(repositoryBefore.count()).toBe(1);
    expect(repositoryBefore.find("a")?.status).toBe("pending");
    expect(next.manager.repository).not.toBe(repositoryBefore);
    expect(next.manager.repository.find("a")?.status).toBe("completed");
  });

  it("deep-clones reads so callers never reach internal state", () => {
    const job = createJob(makeJobInput("a", { metadata: { tags: ["t"] } }));
    const repository = new JobRepository([job]);
    const read = repository.find("a") as Job;
    expect(read).not.toBe(repository.find("a"));
    expect(read).toEqual(repository.find("a"));
    expect(read.metadata).not.toBe(repository.find("a")?.metadata);
    read.metadata.tags.push("mutated");
    expect(repository.find("a")?.metadata.tags).toEqual(["t"]);
    expect(cloneJob(job)).toEqual(job);
  });

  it("job creation stays immutable through the lifecycle", async () => {
    let manager = new JobManager();
    manager = manager.registerJob(makeJobInput("life")).manager;
    const original = manager.find("life") as Job;
    manager = manager.startJob("life", { at: NOW }).manager;
    manager = manager.completeJob("life", { at: NOW, output: 1 }).manager;
    expect(manager.find("life")?.status).toBe("completed");
    // The original detached read is unaffected.
    expect(original.status).toBe("pending");
    expect(original.attempts).toBe(0);
    expect(original.executions).toHaveLength(0);
  });

  it("propagates repository errors to the caller", () => {
    const manager = new JobManager();
    expect(() => manager.completeJob("missing", { at: NOW })).toThrow(JobNotFoundError);
  });
});

// ──────────────────────────────────────────────
//  Engine composition (production)
// ──────────────────────────────────────────────

describe("production engine composition", () => {
  it("runBackgroundJobs runs the seeded digest through the singleton", async () => {
    const summary = await runBackgroundJobs({ now: "2030-01-01T00:00:00.000Z" });
    const digest = summary.executed.find((result) => result.reference.jobId === DIGEST_JOB_ID);
    expect(digest).toBeDefined();
    expect(digest?.status).toBe("completed");
  });

  it("records execution history on the digest job", async () => {
    const engine = createProductionJobEngine({ contextEngine: stubContextEngine, now: () => NOW });
    await engine.run({ now: NOW });
    const digest = engine.digestJob() as Job;
    expect(digest.executions).toHaveLength(1);
    expect(digest.executions[0].status).toBe("completed");
    expect(digest.executions[0].attempt).toBe(1);
    expect(digest.executions[0].finishedAt).toBe(NOW);
    expect(digest.executions[0].result?.success).toBe(true);
  });
});
