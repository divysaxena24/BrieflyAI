import { describe, it, expect, vi } from "vitest";
import {
  JobExecutor,
  JobHandlerRegistry,
  type JobExecutionOutcome,
  type JobHandler,
} from "@/lib/jobs/executor";
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

/** Executor with a no-op sleep and a fixed clock (deterministic tests). */
function makeExecutor(handlers: Record<string, JobHandler>): JobExecutor {
  const registry = new JobHandlerRegistry(
    Object.entries(handlers).map(([id, handler]) => ({ id, handler })),
  );
  return new JobExecutor(registry, {
    sleep: async () => undefined,
    now: () => NOW,
  });
}

const okHandler: JobHandler = async () => ({ done: true });
const boomHandler: JobHandler = async () => {
  throw new Error("boom");
};
const syncBoomHandler: JobHandler = () => {
  throw new Error("sync boom");
};
const hangHandler: JobHandler = () => new Promise<never>(() => undefined);

// ──────────────────────────────────────────────
//  Successful execution
// ──────────────────────────────────────────────

describe("successful execution", () => {
  it("completes a job and returns its output", async () => {
    const executor = makeExecutor({ j1: okHandler });
    const outcome = await executor.execute(makeJob("j1"));
    expect(outcome.status).toBe("completed");
    expect(outcome.output).toEqual({ done: true });
    expect(outcome.attempt).toBe(1);
    expect(outcome.attemptsMade).toBe(1);
    expect(outcome.error).toBeUndefined();
  });

  it("reports a non-negative durationMs", async () => {
    const executor = makeExecutor({ j1: okHandler });
    const outcome = await executor.execute(makeJob("j1"));
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes the injected time to the handler context", async () => {
    let seenNow = "";
    const executor = makeExecutor({
      j1: async (context) => {
        seenNow = context.now;
        return context.attempt;
      },
    });
    const outcome = await executor.execute(makeJob("j1"), { now: NOW });
    expect(seenNow).toBe(NOW);
    expect(outcome.output).toBe(1);
  });

  it("passes the abort signal to the handler context", async () => {
    let seenSignal: AbortSignal | undefined;
    const executor = makeExecutor({
      j1: async (context) => {
        seenSignal = context.signal;
        return undefined;
      },
    });
    const controller = new AbortController();
    await executor.execute(makeJob("j1"), { signal: controller.signal });
    expect(seenSignal).toBe(controller.signal);
  });
});

// ──────────────────────────────────────────────
//  Failure isolation
// ──────────────────────────────────────────────

describe("failure isolation", () => {
  it("fails structurally with unknown_job when no handler is registered", async () => {
    const executor = makeExecutor({});
    const outcome = await executor.execute(makeJob("missing"));
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("unknown_job");
  });

  it("isolates a handler throw into a failed outcome (never throws)", async () => {
    const executor = makeExecutor({ j1: boomHandler });
    const outcome = await executor.execute(makeJob("j1"));
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("handler_error");
    expect(outcome.error?.message).toBe("boom");
  });

  it("isolates a synchronous handler throw", async () => {
    const executor = makeExecutor({ j1: syncBoomHandler });
    const outcome = await executor.execute(makeJob("j1"));
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("handler_error");
    expect(outcome.error?.message).toBe("sync boom");
  });

  it("independent jobs continue after a failing job", async () => {
    const executor = makeExecutor({ good: okHandler, bad: boomHandler });
    const good = await executor.execute(makeJob("good"));
    const bad = await executor.execute(makeJob("bad"));
    expect(bad.status).toBe("failed");
    expect(good.status).toBe("completed");
    expect(good.output).toEqual({ done: true });
  });
});

// ──────────────────────────────────────────────
//  Timeout
// ──────────────────────────────────────────────

describe("timeout", () => {
  it("fails a hanging handler with code timeout", async () => {
    const executor = makeExecutor({ j1: hangHandler });
    const outcome = await executor.execute(makeJob("j1"), { timeoutMs: 10 });
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("timeout");
  });

  it("honors the job's metadata timeoutMs", async () => {
    const executor = makeExecutor({ j1: hangHandler });
    const job = makeJob("j1", { metadata: { timeoutMs: 10 } });
    const outcome = await executor.execute(job);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("timeout");
  });

  it("lets a fast handler complete before the timeout", async () => {
    const executor = makeExecutor({ j1: okHandler });
    const outcome = await executor.execute(makeJob("j1"), { timeoutMs: 5000 });
    expect(outcome.status).toBe("completed");
  });
});

// ──────────────────────────────────────────────
//  Cancellation
// ──────────────────────────────────────────────

describe("cancellation", () => {
  it("cancels before execution starts when the signal is already aborted", async () => {
    const executor = makeExecutor({ j1: okHandler });
    const controller = new AbortController();
    controller.abort();
    const outcome = await executor.execute(makeJob("j1"), { signal: controller.signal });
    expect(outcome.status).toBe("cancelled");
    expect(outcome.error?.code).toBe("cancelled");
    expect(outcome.attemptsMade).toBe(0);
  });

  it("cancels an in-flight attempt when the signal aborts", async () => {
    const executor = makeExecutor({ j1: hangHandler });
    const controller = new AbortController();
    const outcomePromise = executor.execute(makeJob("j1"), { signal: controller.signal });
    controller.abort();
    const outcome = await outcomePromise;
    expect(outcome.status).toBe("cancelled");
    expect(outcome.error?.code).toBe("cancelled");
  });

  it("a completed handler wins over a late abort", async () => {
    const executor = makeExecutor({ j1: okHandler });
    const controller = new AbortController();
    const outcome = await executor.execute(makeJob("j1"), { signal: controller.signal });
    controller.abort();
    expect(outcome.status).toBe("completed");
  });
});

// ──────────────────────────────────────────────
//  Retries
// ──────────────────────────────────────────────

describe("retries", () => {
  it("succeeds on a later attempt when retries are configured", async () => {
    let calls = 0;
    const flaky: JobHandler = async () => {
      calls += 1;
      if (calls < 3) throw new Error("flaky");
      return "recovered";
    };
    const executor = makeExecutor({ j1: flaky });
    const job = makeJob("j1", { maxAttempts: 3 });
    const outcome = await executor.execute(job);
    expect(outcome.status).toBe("completed");
    expect(outcome.output).toBe("recovered");
    expect(outcome.attempt).toBe(3);
    expect(outcome.attemptsMade).toBe(3);
  });

  it("fails after exhausting all attempts", async () => {
    let calls = 0;
    const alwaysFail: JobHandler = async () => {
      calls += 1;
      throw new Error("always");
    };
    const executor = makeExecutor({ j1: alwaysFail });
    const job = makeJob("j1", { maxAttempts: 3 });
    const outcome = await executor.execute(job);
    expect(outcome.status).toBe("failed");
    expect(outcome.attempt).toBe(3);
    expect(outcome.attemptsMade).toBe(3);
    expect(calls).toBe(3);
    expect(outcome.error?.message).toBe("always");
  });

  it("does not retry when maxAttempts is 1 (no retries unless configured)", async () => {
    let calls = 0;
    const failing: JobHandler = async () => {
      calls += 1;
      throw new Error("nope");
    };
    const executor = makeExecutor({ j1: failing });
    const outcome = await executor.execute(makeJob("j1"));
    expect(outcome.status).toBe("failed");
    expect(calls).toBe(1);
    expect(outcome.attemptsMade).toBe(1);
  });

  it("waits retryDelayMs between attempts via the injected sleep", async () => {
    const failing: JobHandler = async () => {
      throw new Error("nope");
    };
    const sleepSpy = vi.fn(async () => undefined);
    const registry = new JobHandlerRegistry([{ id: "j1", handler: failing }]);
    const executor = new JobExecutor(registry, { sleep: sleepSpy, now: () => NOW });
    const job = makeJob("j1", { maxAttempts: 3, metadata: { retryDelayMs: 250 } });
    await executor.execute(job);
    expect(sleepSpy).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenCalledWith(250);
  });

  it("does not sleep on the final attempt", async () => {
    const failing: JobHandler = async () => {
      throw new Error("nope");
    };
    const sleepSpy = vi.fn(async () => undefined);
    const registry = new JobHandlerRegistry([{ id: "j1", handler: failing }]);
    const executor = new JobExecutor(registry, { sleep: sleepSpy, now: () => NOW });
    const job = makeJob("j1", { maxAttempts: 2 });
    await executor.execute(job);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
  });

  it("reports the last error after retries are exhausted", async () => {
    const failing: JobHandler = async () => {
      throw new Error("last error");
    };
    const executor = makeExecutor({ j1: failing });
    const outcome = await executor.execute(makeJob("j1", { maxAttempts: 2 }));
    expect(outcome.error?.message).toBe("last error");
  });
});

// ──────────────────────────────────────────────
//  Timeout + retries
// ──────────────────────────────────────────────

describe("timeout with retries", () => {
  it("retries a timed-out attempt", async () => {
    let calls = 0;
    const hangThenOk: JobHandler = () => {
      calls += 1;
      if (calls === 1) return new Promise<never>(() => undefined);
      return Promise.resolve("fast");
    };
    const executor = makeExecutor({ j1: hangThenOk });
    const job = makeJob("j1", { maxAttempts: 2 });
    const outcome = await executor.execute(job, { timeoutMs: 10 });
    expect(outcome.status).toBe("completed");
    expect(outcome.output).toBe("fast");
    expect(outcome.attemptsMade).toBe(2);
  });
});

// ──────────────────────────────────────────────
//  JobHandlerRegistry
// ──────────────────────────────────────────────

describe("JobHandlerRegistry", () => {
  it("registers, looks up, and lists handlers", () => {
    const registry = new JobHandlerRegistry([{ id: "a", handler: okHandler }]);
    expect(registry.has("a")).toBe(true);
    expect(registry.get("a")).toBe(okHandler);
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.list().map((entry) => entry.id)).toEqual(["a"]);
  });

  it("register returns a successor without mutating the receiver", () => {
    const registry = new JobHandlerRegistry();
    const next = registry.register("a", okHandler);
    expect(registry.has("a")).toBe(false);
    expect(next.has("a")).toBe(true);
  });

  it("register rejects duplicate ids", () => {
    const registry = new JobHandlerRegistry([{ id: "a", handler: okHandler }]);
    expect(() => registry.register("a", okHandler)).toThrow();
  });

  it("unregister returns a successor without the handler", () => {
    const registry = new JobHandlerRegistry([{ id: "a", handler: okHandler }, { id: "b", handler: okHandler }]);
    const next = registry.unregister("a");
    expect(next.has("a")).toBe(false);
    expect(next.has("b")).toBe(true);
    expect(registry.has("a")).toBe(true);
  });

  it("unregister is a no-op for unknown ids", () => {
    const registry = new JobHandlerRegistry([{ id: "a", handler: okHandler }]);
    expect(registry.unregister("missing")).toBe(registry);
  });
});

// ──────────────────────────────────────────────
//  Determinism
// ──────────────────────────────────────────────

describe("determinism", () => {
  it("identical jobs and handlers produce identical outcomes", async () => {
    const run = async (): Promise<JobExecutionOutcome> => {
      const executor = makeExecutor({ j1: okHandler });
      return executor.execute(makeJob("j1"), { now: NOW });
    };
    const first = await run();
    const second = await run();
    expect(first.status).toBe(second.status);
    expect(first.output).toEqual(second.output);
    expect(first.attemptsMade).toBe(second.attemptsMade);
  });

  it("never mutates the job", async () => {
    const executor = makeExecutor({ j1: okHandler });
    const job = makeJob("j1");
    const snapshot = JSON.stringify(job);
    await executor.execute(job);
    expect(JSON.stringify(job)).toBe(snapshot);
  });
});
