import { describe, expect, it } from "vitest";
import {
  ActionCancelledError,
  ActionExecutor,
  ActionHandlerRegistry,
  ActionTimeoutError,
  type ActionHandler,
  type ActionHandlerEntry,
} from "@/lib/actions/executor";
import { createActionPlan } from "@/lib/actions/planner";
import { createAction, type Action } from "@/lib/actions/types";

const NOW = "2026-08-10T12:00:00.000Z";

function action(type: Action["type"], overrides: Partial<Parameters<typeof createAction>[0]> = {}): Action {
  return createAction({
    id: `action-${type}`,
    name: type,
    type,
    createdAt: NOW,
    ...overrides,
  });
}

function handlerFor(type: Action["type"], impl?: ActionHandler): ActionHandlerEntry {
  return {
    type,
    handler:
      impl ??
      (async () => ({
        type,
        ok: true,
      })),
  };
}

describe("ActionHandlerRegistry", () => {
  it("registers and looks up handlers by type", () => {
    const registry = new ActionHandlerRegistry([handlerFor("search_gmail")]);
    expect(registry.has("search_gmail")).toBe(true);
    expect(registry.get("search_gmail")).toBeDefined();
    expect(registry.get("search_calendar")).toBeUndefined();
  });

  it("register/unregister return new registries without mutating the receiver", () => {
    const registry = new ActionHandlerRegistry();
    const next = registry.register("search_gmail", handlerFor("search_gmail").handler);
    expect(next.has("search_gmail")).toBe(true);
    expect(registry.has("search_gmail")).toBe(false);
    const removed = next.unregister("search_gmail");
    expect(removed.has("search_gmail")).toBe(false);
    expect(next.has("search_gmail")).toBe(true);
  });

  it("register throws on duplicate types; unregister of unknown is a no-op", () => {
    const registry = new ActionHandlerRegistry([handlerFor("search_gmail")]);
    expect(() => registry.register("search_gmail", handlerFor("search_gmail").handler)).toThrow(
      /already contains/,
    );
    expect(registry.unregister("missing")).toBe(registry);
  });

  it("registerMany adds several handlers at once", () => {
    const registry = new ActionHandlerRegistry().registerMany([
      handlerFor("search_gmail"),
      handlerFor("search_calendar"),
    ]);
    expect(registry.list()).toHaveLength(2);
  });

  it("list returns a snapshot in registration order", () => {
    const registry = new ActionHandlerRegistry([handlerFor("search_calendar"), handlerFor("search_gmail")]);
    expect(registry.list().map((entry) => entry.type)).toEqual([
      "search_calendar",
      "search_gmail",
    ]);
  });
});

describe("ActionExecutor.execute (single action)", () => {
  it("runs the handler and returns a completed result", async () => {
    const executor = new ActionExecutor(
      new ActionHandlerRegistry([handlerFor("search_gmail")]),
      { now: () => NOW },
    );
    const result = await executor.execute(action("search_gmail"));
    expect(result.status).toBe("completed");
    expect(result.attempt).toBe(1);
    expect(result.attemptsMade).toBe(1);
    expect(result.output).toEqual({ type: "search_gmail", ok: true });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fails structurally for unknown types (never throws)", async () => {
    const executor = new ActionExecutor(new ActionHandlerRegistry(), { now: () => NOW });
    const result = await executor.execute(action("custom"));
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("unknown_action");
  });

  it("passes a running-view action, injected now, and signal to the handler", async () => {
    let seen: { status: string; now: string; userId?: string } | undefined;
    const executor = new ActionExecutor(
      new ActionHandlerRegistry([
        handlerFor("search_gmail", async (context) => {
          seen = { status: context.action.status, now: context.now, userId: context.userId };
          return "ok";
        }),
      ]),
      { now: () => NOW },
    );
    await executor.execute(action("search_gmail"), { now: NOW, userId: "user-1" });
    expect(seen).toEqual({ status: "running", now: NOW, userId: "user-1" });
  });

  it("isolates a throwing handler into a failed result", async () => {
    const executor = new ActionExecutor(
      new ActionHandlerRegistry([
        handlerFor("search_gmail", async () => {
          throw new Error("boom");
        }),
      ]),
      { now: () => NOW },
    );
    const result = await executor.execute(action("search_gmail"));
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("handler_error");
    expect(result.error?.message).toContain("boom");
  });

  it("cancels before execution when the signal is already aborted", async () => {
    const executor = new ActionExecutor(
      new ActionHandlerRegistry([handlerFor("search_gmail")]),
      { now: () => NOW },
    );
    const controller = new AbortController();
    controller.abort();
    const result = await executor.execute(action("search_gmail"), { signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(result.error?.code).toBe("cancelled");
  });

  it("cancels an in-flight handler when the signal aborts", async () => {
    let release: (() => void) | undefined;
    const executor = new ActionExecutor(
      new ActionHandlerRegistry([
        handlerFor("search_gmail", () =>
          new Promise((resolve) => {
            release = () => resolve("late");
          }),
        ),
      ]),
      { now: () => NOW },
    );
    const controller = new AbortController();
    const pending = executor.execute(action("search_gmail"), { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(result.error?.code).toBe("cancelled");
    release?.();
  });

  it("times out a hanging handler", async () => {
    const executor = new ActionExecutor(
      new ActionHandlerRegistry([
        handlerFor("search_gmail", () => new Promise(() => undefined)),
      ]),
      { now: () => NOW },
    );
    const result = await executor.execute(action("search_gmail"), { timeoutMs: 5 });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("timeout");
  });

  it("retries only when configured (maxAttempts > 1)", async () => {
    const attempts: number[] = [];
    const executor = new ActionExecutor(
      new ActionHandlerRegistry([
        handlerFor("search_gmail", async () => {
          attempts.push(1);
          if (attempts.length < 3) throw new Error("flaky");
          return "ok";
        }),
      ]),
      { now: () => NOW, sleep: async () => undefined },
    );
    const result = await executor.execute(
      action("search_gmail", { maxAttempts: 3, metadata: { retryDelayMs: 1 } }),
    );
    expect(result.status).toBe("completed");
    expect(attempts).toHaveLength(3);
    expect(result.attemptsMade).toBe(3);
  });

  it("fails after exhausting attempts", async () => {
    const executor = new ActionExecutor(
      new ActionHandlerRegistry([
        handlerFor("search_gmail", async () => {
          throw new Error("always");
        }),
      ]),
      { now: () => NOW, sleep: async () => undefined },
    );
    const result = await executor.execute(action("search_gmail", { maxAttempts: 2 }));
    expect(result.status).toBe("failed");
    expect(result.attemptsMade).toBe(2);
    expect(result.attempt).toBe(2);
  });
});

describe("ActionExecutor.executePlan", () => {
  const registry = (): ActionHandlerRegistry =>
    new ActionHandlerRegistry([
      handlerFor("search_gmail", async () => ({ emails: 1 })),
      handlerFor("search_calendar", async () => ({ events: 2 })),
      handlerFor("search_drive", async () => ({ files: 3 })),
    ]);

  function plan(actions: readonly Action[]): ReturnType<typeof createActionPlan> {
    return createActionPlan({ intent: "x", userId: "u", now: NOW, actions });
  }

  it("executes independent actions (wave scheduling) and returns one result per action", async () => {
    const executor = new ActionExecutor(registry(), { now: () => NOW });
    const actions = [action("search_gmail"), action("search_calendar")];
    const result = await executor.executePlan(plan(actions));
    expect(result.planId).toBe(plan(actions).id);
    expect(result.results).toHaveLength(2);
    expect(result.completedActionIds.sort()).toEqual(
      actions.map((a) => a.id).sort(),
    );
    expect(result.failedActionIds).toEqual([]);
    expect(result.cancelledActionIds).toEqual([]);
  });

  it("runs independent actions concurrently", async () => {
    const order: string[] = [];
    const slow = new ActionHandlerRegistry([
      handlerFor("search_gmail", async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("gmail");
        return "g";
      }),
      handlerFor("search_calendar", async () => {
        order.push("calendar");
        return "c";
      }),
    ]);
    const executor = new ActionExecutor(slow, { now: () => NOW });
    await executor.executePlan(plan([action("search_gmail"), action("search_calendar")]));
    // Both started before the slow one finished → parallel.
    expect(order).toEqual(["calendar", "gmail"]);
  });

  it("gates dependent actions on their dependencies", async () => {
    const order: string[] = [];
    const registry = new ActionHandlerRegistry([
      handlerFor("search_gmail", async () => {
        order.push("gmail");
        return "g";
      }),
      handlerFor("search_calendar", async () => {
        order.push("calendar");
        return "c";
      }),
    ]);
    const executor = new ActionExecutor(registry, { now: () => NOW });
    const gmail = action("search_gmail");
    const calendar = action("search_calendar", { dependsOn: [gmail.id] });
    await executor.executePlan(plan([gmail, calendar]));
    expect(order).toEqual(["gmail", "calendar"]);
  });

  it("cascades dependency failures (dependent never runs)", async () => {
    const ran: string[] = [];
    const registry = new ActionHandlerRegistry([
      handlerFor("search_gmail", async () => {
        throw new Error("down");
      }),
      handlerFor("search_calendar", async () => {
        ran.push("calendar");
        return "c";
      }),
    ]);
    const executor = new ActionExecutor(registry, { now: () => NOW });
    const gmail = action("search_gmail");
    const calendar = action("search_calendar", { dependsOn: [gmail.id] });
    const result = await executor.executePlan(plan([gmail, calendar]));
    expect(ran).toEqual([]);
    expect(result.failedActionIds).toEqual([gmail.id, calendar.id]);
    const calendarResult = result.results.find((r) => r.actionId === calendar.id);
    expect(calendarResult?.error?.code).toBe("dependency_failed");
  });

  it("keeps independent actions running when a sibling fails (failure isolation)", async () => {
    const registry = new ActionHandlerRegistry([
      handlerFor("search_gmail", async () => {
        throw new Error("down");
      }),
      handlerFor("search_calendar", async () => ({ events: 2 })),
    ]);
    const executor = new ActionExecutor(registry, { now: () => NOW });
    const gmail = action("search_gmail");
    const calendar = action("search_calendar");
    const result = await executor.executePlan(plan([gmail, calendar]));
    expect(result.failedActionIds).toEqual([gmail.id]);
    expect(result.completedActionIds).toEqual([calendar.id]);
  });

  it("cancels pending actions when the plan signal aborts", async () => {
    let resolveGmail: (() => void) | undefined;
    const registry = new ActionHandlerRegistry([
      handlerFor("search_gmail", () =>
        new Promise((resolve) => {
          resolveGmail = () => resolve("g");
        }),
      ),
      handlerFor("search_calendar", async () => "c"),
    ]);
    const executor = new ActionExecutor(registry, { now: () => NOW });
    const gmail = action("search_gmail");
    const calendar = action("search_calendar", { dependsOn: [gmail.id] });
    const controller = new AbortController();
    const pending = executor.executePlan(plan([gmail, calendar]), { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.cancelledActionIds).toContain(calendar.id);
    resolveGmail?.();
  });

  it("is deterministic for identical plans and handlers", async () => {
    const run = async (): Promise<string[]> => {
      const executor = new ActionExecutor(registry(), { now: () => NOW });
      const actions = [action("search_drive"), action("search_gmail")];
      const results = (await executor.executePlan(plan(actions))).results;
      // Wall-clock durationMs legitimately varies between runs; compare the
      // deterministic projection instead.
      return results.map((r) => `${r.actionId}:${r.status}`);
    };
    expect(await run()).toEqual(await run());
  });

  it("never throws even when every handler fails", async () => {
    const registry = new ActionHandlerRegistry([
      handlerFor("search_gmail", async () => {
        throw new Error("1");
      }),
      handlerFor("search_calendar", async () => {
        throw new Error("2");
      }),
    ]);
    const executor = new ActionExecutor(registry, { now: () => NOW });
    const result = await executor.executePlan(
      plan([action("search_gmail"), action("search_calendar")]),
    );
    expect(result.failedActionIds).toHaveLength(2);
  });
});

describe("ActionExecutor with real timeouts", () => {
  it("ActionTimeoutError and ActionCancelledError are typed errors", () => {
    expect(new ActionTimeoutError().name).toBe("ActionTimeoutError");
    expect(new ActionCancelledError().name).toBe("ActionCancelledError");
  });
});
