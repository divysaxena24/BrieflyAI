import { describe, it, expect } from "vitest";
import { JobManager } from "@/lib/jobs/manager";
import { JobRepository, JobNotFoundError, JobDuplicateError } from "@/lib/jobs/repository";
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

function seed(count: number): JobManager {
  const manager = new JobManager();
  const inputs: CreateJobInput[] = [];
  for (let index = 0; index < count; index += 1) {
    inputs.push(makeJobInput(`j${index}`));
  }
  return manager.bulkRegister(inputs).manager;
}

// ──────────────────────────────────────────────
//  register / unregister / schedule
// ──────────────────────────────────────────────

describe("register and schedule", () => {
  it("registerJob adds a job and returns it plus the successor", () => {
    const manager = new JobManager();
    const { manager: next, job } = manager.registerJob(makeJobInput("j1"));
    expect(job.id).toBe("j1");
    expect(next.count()).toBe(1);
    expect(next.find("j1")?.name).toBe("Job j1");
  });

  it("keeps the receiver unchanged (immutability)", () => {
    const manager = new JobManager();
    manager.registerJob(makeJobInput("j1"));
    expect(manager.count()).toBe(0);
  });

  it("scheduleJob registers a scheduled job (same semantics as registerJob)", () => {
    const manager = new JobManager();
    const { manager: next, job } = manager.scheduleJob(
      makeJobInput("s1", {
        trigger: "recurring",
        schedule: { everyMs: 3_600_000 },
        scheduledAt: NOW,
      }),
    );
    expect(job.trigger).toBe("recurring");
    expect(next.find("s1")?.schedule?.everyMs).toBe(3_600_000);
  });

  it("rejects duplicate ids", () => {
    const manager = new JobManager();
    const { manager: next } = manager.registerJob(makeJobInput("j1"));
    expect(() => next.registerJob(makeJobInput("j1"))).toThrow(JobDuplicateError);
  });

  it("unregisterJob removes the job entirely", () => {
    const manager = new JobManager();
    const { manager: withJob } = manager.registerJob(makeJobInput("j1"));
    const next = withJob.unregisterJob("j1");
    expect(next.has("j1")).toBe(false);
    expect(next.count()).toBe(0);
  });

  it("unregisterJob throws for an unknown id", () => {
    const manager = new JobManager();
    expect(() => manager.unregisterJob("missing")).toThrow(JobNotFoundError);
  });

  it("bulkRegister registers many jobs atomically", () => {
    const manager = new JobManager();
    const { manager: next, jobs } = manager.bulkRegister([
      makeJobInput("a"),
      makeJobInput("b"),
      makeJobInput("c"),
    ]);
    expect(jobs.map((job) => job.id)).toEqual(["a", "b", "c"]);
    expect(next.count()).toBe(3);
    expect(manager.count()).toBe(0);
  });

  it("bulkRegister throws on the first duplicate without changing the receiver", () => {
    const manager = new JobManager();
    const { manager: next } = manager.registerJob(makeJobInput("a"));
    expect(() => next.bulkRegister([makeJobInput("a"), makeJobInput("b")])).toThrow(
      JobDuplicateError,
    );
    expect(next.count()).toBe(1);
  });
});

// ──────────────────────────────────────────────
//  startJob
// ──────────────────────────────────────────────

describe("startJob", () => {
  it("marks the job running, sets startedAt, and appends a running execution", () => {
    const manager = new JobManager();
    const { manager: withJob } = manager.registerJob(makeJobInput("j1"));
    const { manager: next, job, execution } = withJob.startJob("j1", { at: NOW });
    expect(job.status).toBe("running");
    expect(job.startedAt).toBe(NOW);
    expect(job.attempts).toBe(1);
    expect(execution.status).toBe("running");
    expect(execution.attempt).toBe(1);
    expect(next.find("j1")?.status).toBe("running");
    expect(next.find("j1")?.executions).toHaveLength(1);
    expect(withJob.find("j1")?.status).toBe("pending");
  });

  it("increments attempts across starts", () => {
    let manager = new JobManager();
    manager = manager.registerJob(makeJobInput("j1")).manager;
    manager = manager.startJob("j1", { at: NOW }).manager;
    const { manager: next, job } = manager.startJob("j1", { at: NOW });
    expect(job.attempts).toBe(2);
    expect(next.find("j1")?.attempts).toBe(2);
  });

  it("clears completedAt on a fresh start", () => {
    let manager = new JobManager();
    manager = manager.registerJob(makeJobInput("j1")).manager;
    manager = manager.completeJob("j1", { at: NOW }).manager;
    const { manager: next } = manager.startJob("j1", { at: NOW });
    expect(next.find("j1")?.completedAt).toBeUndefined();
  });

  it("throws for an unknown id", () => {
    const manager = new JobManager();
    expect(() => manager.startJob("missing", { at: NOW })).toThrow(JobNotFoundError);
  });
});

// ──────────────────────────────────────────────
//  completeJob
// ──────────────────────────────────────────────

describe("completeJob", () => {
  it("marks the job completed with result and finalizes the execution", () => {
    let manager = new JobManager();
    manager = manager.registerJob(makeJobInput("j1")).manager;
    manager = manager.startJob("j1", { at: NOW }).manager;
    const { manager: next, job } = manager.completeJob("j1", {
      at: NOW,
      output: { ok: true },
      durationMs: 10,
      attempt: 1,
    });
    expect(job.status).toBe("completed");
    expect(job.completedAt).toBe(NOW);
    expect(job.result).toEqual({ success: true, output: { ok: true }, durationMs: 10 });
    expect(job.executions).toHaveLength(1);
    expect(job.executions[0].status).toBe("completed");
    expect(job.executions[0].finishedAt).toBe(NOW);
    expect(job.executions[0].durationMs).toBe(10);
    expect(next.find("j1")?.status).toBe("completed");
  });

  it("clears a previous error", () => {
    let manager = new JobManager();
    manager = manager.registerJob(makeJobInput("j1")).manager;
    manager = manager.startJob("j1", { at: NOW }).manager;
    manager = manager.failJob("j1", {
      at: NOW,
      error: { code: "handler_error", message: "boom" },
    }).manager;
    manager = manager.startJob("j1", { at: NOW }).manager;
    const { job } = manager.completeJob("j1", { at: NOW });
    expect(job.error).toBeUndefined();
    expect(job.status).toBe("completed");
  });

  it("throws for an unknown id", () => {
    const manager = new JobManager();
    expect(() => manager.completeJob("missing", { at: NOW })).toThrow(JobNotFoundError);
  });
});

// ──────────────────────────────────────────────
//  failJob / cancelJob
// ──────────────────────────────────────────────

describe("failJob and cancelJob", () => {
  it("marks the job failed with the structured error", () => {
    let manager = new JobManager();
    manager = manager.registerJob(makeJobInput("j1")).manager;
    manager = manager.startJob("j1", { at: NOW }).manager;
    const { manager: next, job } = manager.failJob("j1", {
      at: NOW,
      error: { code: "timeout", message: "slow" },
      durationMs: 5000,
      attempt: 1,
    });
    expect(job.status).toBe("failed");
    expect(job.error).toEqual({ code: "timeout", message: "slow" });
    expect(job.executions[0].status).toBe("failed");
    expect(job.executions[0].error).toEqual({ code: "timeout", message: "slow" });
    expect(next.find("j1")?.status).toBe("failed");
  });

  it("cancels a job with an optional reason", () => {
    let manager = new JobManager();
    manager = manager.registerJob(makeJobInput("j1")).manager;
    manager = manager.startJob("j1", { at: NOW }).manager;
    const { manager: next, job } = manager.cancelJob("j1", {
      at: NOW,
      error: { code: "cancelled", message: "stopped" },
    });
    expect(job.status).toBe("cancelled");
    expect(job.error).toEqual({ code: "cancelled", message: "stopped" });
    expect(job.executions[0].status).toBe("cancelled");
    expect(next.find("j1")?.status).toBe("cancelled");
  });

  it("cancels without a reason when omitted", () => {
    let manager = new JobManager();
    manager = manager.registerJob(makeJobInput("j1")).manager;
    manager = manager.startJob("j1", { at: NOW }).manager;
    const { job } = manager.cancelJob("j1", { at: NOW });
    expect(job.status).toBe("cancelled");
    expect(job.error).toBeUndefined();
  });

  it("throws for unknown ids", () => {
    const manager = new JobManager();
    expect(() => manager.failJob("missing", { at: NOW, error: { code: "x", message: "y" } })).toThrow(
      JobNotFoundError,
    );
    expect(() => manager.cancelJob("missing", { at: NOW })).toThrow(JobNotFoundError);
  });
});

// ──────────────────────────────────────────────
//  retryJob
// ──────────────────────────────────────────────

describe("retryJob", () => {
  it("re-enables a failed job to pending and clears the error", () => {
    let manager = new JobManager();
    manager = manager.registerJob(makeJobInput("j1")).manager;
    manager = manager.startJob("j1", { at: NOW }).manager;
    manager = manager.failJob("j1", { at: NOW, error: { code: "x", message: "y" } }).manager;
    const { manager: next, job } = manager.retryJob("j1");
    expect(job.status).toBe("pending");
    expect(job.error).toBeUndefined();
    expect(job.result).toBeUndefined();
    expect(next.find("j1")?.status).toBe("pending");
    expect(next.find("j1")?.executions).toHaveLength(1);
  });

  it("re-enables a cancelled job to pending", () => {
    let manager = new JobManager();
    manager = manager.registerJob(makeJobInput("j1")).manager;
    manager = manager.startJob("j1", { at: NOW }).manager;
    manager = manager.cancelJob("j1", { at: NOW }).manager;
    const { job } = manager.retryJob("j1");
    expect(job.status).toBe("pending");
  });

  it("leaves non-failed/cancelled jobs unchanged", () => {
    let manager = new JobManager();
    manager = manager.registerJob(makeJobInput("j1")).manager;
    const { manager: next, job } = manager.retryJob("j1");
    expect(job.status).toBe("pending");
    expect(next).toBe(manager);
  });

  it("throws for an unknown id", () => {
    const manager = new JobManager();
    expect(() => manager.retryJob("missing")).toThrow(JobNotFoundError);
  });
});

// ──────────────────────────────────────────────
//  archive / restore / reschedule
// ──────────────────────────────────────────────

describe("archive, restore, reschedule", () => {
  it("archiveJob flags the job as archived without removing it", () => {
    const manager = new JobManager();
    const { manager: withJob } = manager.registerJob(makeJobInput("j1"));
    const next = withJob.archiveJob("j1");
    expect(next.find("j1")?.archived).toBe(true);
    expect(next.has("j1")).toBe(true);
    expect(withJob.find("j1")?.archived).toBe(false);
  });

  it("restoreJob clears the archived flag", () => {
    const manager = new JobManager();
    const { manager: withJob } = manager.registerJob(makeJobInput("j1"));
    const archived = withJob.archiveJob("j1");
    const next = archived.restoreJob("j1");
    expect(next.find("j1")?.archived).toBe(false);
  });

  it("rescheduleJob re-arms a recurring job to its next occurrence", () => {
    const manager = new JobManager();
    const { manager: withJob } = manager.scheduleJob(
      makeJobInput("r1", {
        trigger: "recurring",
        schedule: { everyMs: 3_600_000, startsAt: "2026-08-10T09:00:00.000Z" },
        scheduledAt: "2026-08-10T09:00:00.000Z",
      }),
    );
    const { manager: next, job } = withJob.rescheduleJob("r1", "2026-08-10T09:30:00.000Z");
    expect(job.status).toBe("pending");
    expect(job.scheduledAt).toBe("2026-08-10T10:00:00.000Z");
    expect(next.find("r1")?.scheduledAt).toBe("2026-08-10T10:00:00.000Z");
  });

  it("rescheduleJob is a no-op for non-recurring jobs", () => {
    const manager = new JobManager();
    const { manager: withJob } = manager.registerJob(makeJobInput("j1"));
    const { manager: next, job } = withJob.rescheduleJob("j1", NOW);
    expect(job.scheduledAt).toBeUndefined();
    expect(next).toBe(withJob);
  });

  it("throws for unknown ids on archive/restore/reschedule", () => {
    const manager = new JobManager();
    expect(() => manager.archiveJob("missing")).toThrow(JobNotFoundError);
    expect(() => manager.restoreJob("missing")).toThrow(JobNotFoundError);
    expect(() => manager.rescheduleJob("missing", NOW)).toThrow(JobNotFoundError);
  });
});

// ──────────────────────────────────────────────
//  bulkCancel
// ──────────────────────────────────────────────

describe("bulkCancel", () => {
  it("cancels many jobs atomically", () => {
    const manager = seed(3);
    const next = manager.bulkCancel(["j0", "j2"]);
    expect(next.find("j0")?.status).toBe("cancelled");
    expect(next.find("j1")?.status).toBe("pending");
    expect(next.find("j2")?.status).toBe("cancelled");
  });

  it("keeps the receiver unchanged", () => {
    const manager = seed(3);
    manager.bulkCancel(["j0"]);
    expect(manager.find("j0")?.status).toBe("pending");
  });

  it("throws on the first unknown id without changing the receiver", () => {
    const manager = seed(2);
    expect(() => manager.bulkCancel(["j0", "missing"])).toThrow(JobNotFoundError);
    expect(manager.find("j0")?.status).toBe("pending");
  });
});

// ──────────────────────────────────────────────
//  Read passthroughs / scale / determinism
// ──────────────────────────────────────────────

describe("reads, scale, determinism", () => {
  it("exposes find, list, has, count over the repository", () => {
    const manager = seed(3);
    expect(manager.find("j1")?.id).toBe("j1");
    expect(manager.has("j1")).toBe(true);
    expect(manager.has("missing")).toBe(false);
    expect(manager.count()).toBe(3);
    expect(manager.list().map((job) => job.id)).toEqual(["j0", "j1", "j2"]);
  });

  it("exposes the backing repository readonly", () => {
    const manager = seed(1);
    expect(manager.repository).toBeInstanceOf(JobRepository);
    expect(manager.repository.count()).toBe(1);
  });

  it("returns detached clones from reads", () => {
    const manager = seed(1);
    const job = manager.find("j0") as Job;
    job.metadata.tags.push("mutated");
    expect(manager.find("j0")?.metadata.tags).toEqual([]);
  });

  it("handles 1000 registered jobs", () => {
    const manager = seed(1000);
    expect(manager.count()).toBe(1000);
    expect(manager.list()[999].id).toBe("j999");
  });

  it("produces deep-equal states from identical operation sequences", () => {
    const run = (): JobManager => {
      let manager = new JobManager();
      manager = manager.registerJob(makeJobInput("a")).manager;
      manager = manager.startJob("a", { at: NOW }).manager;
      manager = manager.completeJob("a", { at: NOW, output: 1 }).manager;
      return manager;
    };
    expect(run().list()).toEqual(run().list());
  });
});
