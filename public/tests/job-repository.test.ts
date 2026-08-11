import { describe, it, expect } from "vitest";
import {
  JobRepository,
  JobNotFoundError,
  JobDuplicateError,
} from "@/lib/jobs/repository";
import { createJob, type CreateJobInput, type Job, type JobPatch } from "@/lib/jobs/types";

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

// ──────────────────────────────────────────────
//  Construction
// ──────────────────────────────────────────────

describe("construction", () => {
  it("starts empty when constructed without arguments", () => {
    const repository = new JobRepository();
    expect(repository.count()).toBe(0);
    expect(repository.list()).toEqual([]);
  });

  it("stores the initial jobs in order", () => {
    const repository = new JobRepository([makeJob("j1"), makeJob("j2")]);
    expect(repository.count()).toBe(2);
    expect(repository.list().map((job) => job.id)).toEqual(["j1", "j2"]);
  });

  it("snapshots the constructor input (later caller mutation has no effect)", () => {
    const initial = [makeJob("j1")];
    const repository = new JobRepository(initial);
    initial.push(makeJob("j2"));
    initial[0].metadata.tags.push("extra");
    expect(repository.count()).toBe(1);
    expect(repository.find("j1")?.metadata.tags).toEqual([]);
  });

  it("stores detached frozen copies", () => {
    const repository = new JobRepository([makeJob("j1")]);
    const first = repository.find("j1") as Job;
    expect(first).not.toBe(repository.find("j1"));
    expect(repository.find("j1")).toEqual(first);
  });
});

// ──────────────────────────────────────────────
//  add
// ──────────────────────────────────────────────

describe("add", () => {
  it("appends a job and returns it plus the successor repository", () => {
    const repository = new JobRepository();
    const { job, repository: next } = repository.add(makeJob("j1"));
    expect(job.id).toBe("j1");
    expect(next.count()).toBe(1);
    expect(next.list()[0].id).toBe("j1");
  });

  it("keeps the receiver unchanged (immutability)", () => {
    const repository = new JobRepository();
    repository.add(makeJob("j1"));
    expect(repository.count()).toBe(0);
  });

  it("preserves insertion order across adds", () => {
    let repository = new JobRepository();
    repository = repository.add(makeJob("a")).repository;
    repository = repository.add(makeJob("b")).repository;
    repository = repository.add(makeJob("c")).repository;
    expect(repository.list().map((job) => job.id)).toEqual(["a", "b", "c"]);
  });

  it("rejects duplicate ids", () => {
    const repository = new JobRepository([makeJob("j1")]);
    expect(() => repository.add(makeJob("j1"))).toThrow(JobDuplicateError);
  });
});

// ──────────────────────────────────────────────
//  update
// ──────────────────────────────────────────────

describe("update", () => {
  it("applies a partial patch and returns the patched job plus the successor", () => {
    const repository = new JobRepository([makeJob("j1")]);
    const patch: JobPatch = { status: "running", priority: "high" };
    const { job, repository: next } = repository.update("j1", patch);
    expect(job.status).toBe("running");
    expect(job.priority).toBe("high");
    expect(job.name).toBe("Job j1");
    expect(next.find("j1")?.status).toBe("running");
    expect(next.find("j1")?.priority).toBe("high");
  });

  it("keeps insertion position when updating", () => {
    const repository = new JobRepository([makeJob("a"), makeJob("b"), makeJob("c")]);
    const { repository: next } = repository.update("b", { name: "B2" });
    expect(next.list().map((job) => job.id)).toEqual(["a", "b", "c"]);
    expect(next.list()[1].name).toBe("B2");
  });

  it("leaves the receiver unchanged (immutability)", () => {
    const repository = new JobRepository([makeJob("j1")]);
    repository.update("j1", { name: "X" });
    expect(repository.find("j1")?.name).toBe("Job j1");
  });

  it("throws for an unknown id", () => {
    const repository = new JobRepository();
    expect(() => repository.update("missing", { name: "X" })).toThrow(JobNotFoundError);
  });
});

// ──────────────────────────────────────────────
//  replace / remove / clear
// ──────────────────────────────────────────────

describe("replace", () => {
  it("replaces the stored job by id, keeping position", () => {
    const repository = new JobRepository([makeJob("a"), makeJob("b")]);
    const next = repository.replace(makeJob("b", { name: "B2", priority: "critical" }));
    expect(next.list().map((job) => job.id)).toEqual(["a", "b"]);
    expect(next.find("b")?.name).toBe("B2");
    expect(next.find("b")?.priority).toBe("critical");
  });

  it("detaches the replacement from the caller", () => {
    const replacement = makeJob("j1");
    const repository = new JobRepository();
    const { repository: withOne } = repository.add(makeJob("j1"));
    const next = withOne.replace(replacement);
    replacement.metadata.tags.push("changed");
    (replacement as unknown as { name: string }).name = "changed";
    expect(next.find("j1")?.metadata.tags).toEqual([]);
    expect(next.find("j1")?.name).toBe("Job j1");
  });

  it("throws for an unknown id", () => {
    const repository = new JobRepository();
    expect(() => repository.replace(makeJob("missing"))).toThrow(JobNotFoundError);
  });
});

describe("remove and clear", () => {
  it("removes a job", () => {
    const repository = new JobRepository([makeJob("j1"), makeJob("j2")]);
    const next = repository.remove("j1");
    expect(next.has("j1")).toBe(false);
    expect(next.has("j2")).toBe(true);
    expect(next.count()).toBe(1);
  });

  it("throws for an unknown id on remove", () => {
    const repository = new JobRepository();
    expect(() => repository.remove("missing")).toThrow(JobNotFoundError);
  });

  it("clear returns an empty repository", () => {
    const repository = new JobRepository([makeJob("j1"), makeJob("j2")]);
    const cleared = repository.clear();
    expect(cleared.count()).toBe(0);
    expect(cleared.list()).toEqual([]);
    expect(repository.count()).toBe(2);
  });
});

// ──────────────────────────────────────────────
//  find and filters
// ──────────────────────────────────────────────

describe("find and filters", () => {
  const repository = new JobRepository([
    makeJob("a", { status: "pending", priority: "low", trigger: "manual" }),
    makeJob("b", { status: "completed", priority: "high", trigger: "recurring" }),
    makeJob("c", { status: "failed", priority: "critical", trigger: "scheduled" }),
    makeJob("d", { status: "pending", priority: "high", trigger: "startup" }),
  ]);

  it("find returns a detached clone or undefined", () => {
    expect(repository.find("a")?.id).toBe("a");
    expect(repository.find("missing")).toBeUndefined();
  });

  it("findByStatus filters by status", () => {
    expect(repository.findByStatus("pending").map((job) => job.id)).toEqual(["a", "d"]);
    expect(repository.findByStatus("cancelled")).toEqual([]);
  });

  it("findByPriority filters by priority", () => {
    expect(repository.findByPriority("high").map((job) => job.id)).toEqual(["b", "d"]);
    expect(repository.findByPriority("normal")).toEqual([]);
  });

  it("findByTrigger filters by trigger", () => {
    expect(repository.findByTrigger("recurring").map((job) => job.id)).toEqual(["b"]);
    expect(repository.findByTrigger("shutdown")).toEqual([]);
  });

  it("filters return detached clones", () => {
    const results = repository.findByStatus("pending");
    results[0].metadata.tags.push("mutated");
    expect(repository.findByStatus("pending")[0].metadata.tags).toEqual([]);
  });
});

// ──────────────────────────────────────────────
//  Scheduling queries
// ──────────────────────────────────────────────

describe("scheduling queries", () => {
  const dueAt = "2026-08-10T10:00:00.000Z";
  const repository = new JobRepository([
    // Scheduled, due at exactly `dueAt`.
    makeJob("one-time", {
      trigger: "scheduled",
      schedule: { at: "2026-08-10T10:00:00.000Z" },
      scheduledAt: "2026-08-10T10:00:00.000Z",
    }),
    // Scheduled, not yet due.
    makeJob("future", {
      trigger: "scheduled",
      schedule: { at: "2026-08-10T12:00:00.000Z" },
      scheduledAt: "2026-08-10T12:00:00.000Z",
    }),
    // Recurring, first occurrence in the past.
    makeJob("recurring", {
      trigger: "recurring",
      schedule: { everyMs: 3_600_000, startsAt: "2026-08-10T09:00:00.000Z" },
      scheduledAt: "2026-08-10T09:00:00.000Z",
    }),
    // Manual: no schedule, pending.
    makeJob("manual", { trigger: "manual" }),
    // Completed: never due.
    makeJob("done", { status: "completed", schedule: { at: dueAt }, scheduledAt: dueAt }),
    // Archived pending: never due.
    makeJob("archived", { archived: true }),
    // Scheduled but lacks scheduledAt: never due.
    makeJob("unscheduled", { schedule: { everyMs: 1000 } }),
  ]);

  it("findScheduledJobs returns only scheduled jobs due at now", () => {
    const ids = repository.findScheduledJobs(dueAt).map((job) => job.id);
    expect(ids).toEqual(["one-time", "recurring"]);
  });

  it("findRunnableJobs includes schedule-less pending jobs", () => {
    const ids = repository.findRunnableJobs(dueAt).map((job) => job.id);
    expect(ids).toEqual(["one-time", "recurring", "manual"]);
  });

  it("excludes completed, archived, and unschedulable jobs", () => {
    const ids = repository.findRunnableJobs(dueAt).map((job) => job.id);
    expect(ids).not.toContain("done");
    expect(ids).not.toContain("archived");
    expect(ids).not.toContain("unscheduled");
    expect(ids).not.toContain("future");
  });

  it("returns detached clones from scheduling queries", () => {
    const results = repository.findRunnableJobs(dueAt);
    results[0].metadata.tags.push("mutated");
    expect(repository.findRunnableJobs(dueAt)[0].metadata.tags).toEqual([]);
  });
});

// ──────────────────────────────────────────────
//  has / count / determinism / scale
// ──────────────────────────────────────────────

describe("has, count, determinism, scale", () => {
  it("reports membership and count", () => {
    const repository = new JobRepository([makeJob("j1")]);
    expect(repository.has("j1")).toBe(true);
    expect(repository.has("missing")).toBe(false);
    expect(repository.count()).toBe(1);
  });

  it("produces deep-equal repositories from identical operation sequences", () => {
    const run = (): JobRepository => {
      let repository = new JobRepository();
      repository = repository.add(makeJob("a", { priority: "high" })).repository;
      repository = repository.add(makeJob("b")).repository;
      const { repository: updated } = repository.update("a", { status: "running" });
      repository = updated;
      return repository.remove("b");
    };
    expect(run().list()).toEqual(run().list());
  });

  it("handles 1000 jobs with correct ordering and counts", () => {
    let repository = new JobRepository();
    for (let index = 0; index < 1000; index += 1) {
      repository = repository.add(makeJob(`j${index}`)).repository;
    }
    expect(repository.count()).toBe(1000);
    expect(repository.list()[0].id).toBe("j0");
    expect(repository.list()[999].id).toBe("j999");
    const removed = repository.remove("j500");
    expect(removed.count()).toBe(999);
    expect(removed.list()[500].id).toBe("j501");
  });

  it("update is O(n) friendly at scale (1000 jobs)", () => {
    let repository = new JobRepository();
    for (let index = 0; index < 1000; index += 1) {
      repository = repository.add(makeJob(`j${index}`)).repository;
    }
    const { repository: updated } = repository.update("j999", { name: "last" });
    expect(updated.find("j999")?.name).toBe("last");
    expect(updated.count()).toBe(1000);
  });
});
