import { describe, it, expect } from "vitest";
import {
  WorkerExecutor,
  WorkerTaskHandlerRegistry,
  WorkerTimeoutError,
} from "@/lib/workers/executor";
import { createWorkerTask, touchWorkerTask, type WorkerTask } from "@/lib/workers/types";

const NOW = "2026-08-11T09:00:00.000Z";

function task(extra: Partial<Parameters<typeof createWorkerTask>[0]> = {}): WorkerTask {
  return createWorkerTask({
    name: "t",
    kind: "custom",
    payload: { kind: "custom", input: { value: 1 } },
    createdAt: NOW,
    ...extra,
  });
}

describe("WorkerTaskHandlerRegistry", () => {
  it("registers and resolves handlers by kind", () => {
    const registry = new WorkerTaskHandlerRegistry([
      { kind: "custom", handler: async () => "ok" },
    ]);
    expect(registry.has("custom")).toBe(true);
    expect(registry.get("custom")).toBeDefined();
    expect(registry.get("job")).toBeUndefined();
  });

  it("is immutable and rejects duplicates", () => {
    const registry = new WorkerTaskHandlerRegistry();
    const next = registry.register("custom", async () => "ok");
    expect(registry.has("custom")).toBe(false);
    expect(next.has("custom")).toBe(true);
    expect(() => next.register("custom", async () => "nope")).toThrow(/already contains/);
  });

  it("registers many at once", () => {
    const registry = new WorkerTaskHandlerRegistry().registerMany([
      { kind: "custom", handler: async () => "c" },
      { kind: "job", handler: async () => "j" },
    ]);
    expect(registry.list()).toHaveLength(2);
  });
});

describe("WorkerExecutor.execute", () => {
  it("completes a task through its handler", async () => {
    const executor = new WorkerExecutor(
      new WorkerTaskHandlerRegistry([
        { kind: "custom", handler: async () => ({ done: true }) },
      ]),
      { now: () => NOW },
    );
    const result = await executor.execute(task(), { workerId: "w1", now: NOW });
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ done: true });
    expect(result.attemptsMade).toBe(0);
  });

  it("fails structurally for unknown kinds", async () => {
    const executor = new WorkerExecutor(new WorkerTaskHandlerRegistry(), { now: () => NOW });
    const result = await executor.execute(
      createWorkerTask({ name: "t", kind: "digest", payload: { kind: "digest", template: "m", userId: "u" }, createdAt: NOW }),
      { workerId: "w1", now: NOW },
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("unknown_task_kind");
  });

  it("cancels before execution when the signal is already aborted", async () => {
    const executor = new WorkerExecutor(
      new WorkerTaskHandlerRegistry([
        { kind: "custom", handler: async () => "should-not-run" },
      ]),
      { now: () => NOW },
    );
    const controller = new AbortController();
    controller.abort();
    const result = await executor.execute(task(), {
      workerId: "w1",
      now: NOW,
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(result.error?.code).toBe("cancelled");
  });

  it("isolates handler failures into structured errors", async () => {
    const executor = new WorkerExecutor(
      new WorkerTaskHandlerRegistry([
        {
          kind: "custom",
          handler: async () => {
            throw new Error("boom");
          },
        },
      ]),
      { now: () => NOW },
    );
    const result = await executor.execute(task(), { workerId: "w1", now: NOW });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("handler_error");
    expect(result.error?.message).toContain("boom");
  });

  it("times out hanging handlers", async () => {
    const executor = new WorkerExecutor(
      new WorkerTaskHandlerRegistry([
        {
          kind: "custom",
          handler: () =>
            new Promise<never>((resolve) => {
              setTimeout(resolve, 500);
            }),
        },
      ]),
      { now: () => NOW },
    );
    const result = await executor.execute(task({ timeoutMs: 20 }), {
      workerId: "w1",
      now: NOW,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("timeout");
    expect(result.error?.retryable).toBe(true);
  });

  it("cancels in-flight attempts when the signal fires", async () => {
    const executor = new WorkerExecutor(
      new WorkerTaskHandlerRegistry([
        {
          kind: "custom",
          handler: () =>
            new Promise<never>((resolve) => {
              setTimeout(resolve, 500);
            }),
        },
      ]),
      { now: () => NOW },
    );
    const controller = new AbortController();
    const promise = executor.execute(task(), {
      workerId: "w1",
      now: NOW,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    const result = await promise;
    expect(result.status).toBe("cancelled");
    expect(result.error?.code).toBe("cancelled");
  });

  it("invokes the heartbeat hook before running", async () => {
    let beats = 0;
    const executor = new WorkerExecutor(
      new WorkerTaskHandlerRegistry([
        { kind: "custom", handler: async () => "ok" },
      ]),
      { now: () => NOW },
    );
    await executor.execute(task(), {
      workerId: "w1",
      now: NOW,
      heartbeat: () => {
        beats += 1;
      },
    });
    expect(beats).toBe(1);
  });

  it("injects task payload and attempt into the handler context", async () => {
    let seenAttempt = 0;
    let seenValue: unknown;
    const executor = new WorkerExecutor(
      new WorkerTaskHandlerRegistry([
        {
          kind: "custom",
          handler: async (context) => {
            seenAttempt = context.attempt;
            const input = (context.payload as { input: { value: number } }).input;
            seenValue = input.value;
            return "ok";
          },
        },
      ]),
      { now: () => NOW },
    );
    const t = touchWorkerTask(
      createWorkerTask({
        name: "t",
        kind: "custom",
        payload: { kind: "custom", input: { value: 42 } },
        createdAt: NOW,
      }),
      { attempts: 2 },
    );
    await executor.execute(t, { workerId: "w1", now: NOW });
    expect(seenAttempt).toBe(2);
    expect(seenValue).toBe(42);
  });

  it("executeAttempt aliases execute with attempt metadata", async () => {
    const executor = new WorkerExecutor(
      new WorkerTaskHandlerRegistry([{ kind: "custom", handler: async () => "ok" }]),
      { now: () => NOW },
    );
    const outcome = await executor.executeAttempt(task(), { workerId: "w1", now: NOW });
    expect(outcome.status).toBe("completed");
    expect(outcome.output).toBe("ok");
    expect(outcome.attempt).toBe(1);
  });
});

describe("determinism", () => {
  it("produces identical outcomes for identical inputs", async () => {
    const executor = new WorkerExecutor(
      new WorkerTaskHandlerRegistry([
        { kind: "custom", handler: async (context) => context.now },
      ]),
      { now: () => NOW, clockMs: () => 1000 },
    );
    const a = await executor.execute(task(), { workerId: "w1", now: NOW });
    const b = await executor.execute(task(), { workerId: "w1", now: NOW });
    expect(a).toEqual(b);
  });
});

describe("WorkerTimeoutError", () => {
  it("is an Error with a stable name", () => {
    const error = new WorkerTimeoutError();
    expect(error.name).toBe("WorkerTimeoutError");
    expect(error).toBeInstanceOf(Error);
  });
});
