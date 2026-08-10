import { describe, expect, it } from "vitest";
import {
  createAction,
  createActionExecution,
  createActionHistory,
  createActionReference,
  createActionSummary,
  cloneAction,
  estimateActionCost,
  freezeAction,
  hashAction,
  isActionDue,
  isActionRunnable,
  touchAction,
  PRIORITY_COST,
  PRIORITY_RANK,
  DEFAULT_ACTION_ARCHIVED,
  DEFAULT_ACTION_MAX_ATTEMPTS,
  DEFAULT_ACTION_PRIORITY,
  DEFAULT_ACTION_STATUS,
  DEFAULT_ACTION_TRIGGER,
  type Action,
  type ActionPatch,
} from "@/lib/actions/types";

const NOW = "2026-08-10T12:00:00.000Z";

function baseInput(): Parameters<typeof createAction>[0] {
  return {
    name: "Search Gmail",
    type: "search_gmail",
    createdAt: NOW,
  };
}

describe("createAction", () => {
  it("applies defaults for status, priority, trigger, maxAttempts, archived, dependsOn, tags", () => {
    const action = createAction(baseInput());
    expect(action.status).toBe(DEFAULT_ACTION_STATUS);
    expect(action.priority).toBe(DEFAULT_ACTION_PRIORITY);
    expect(action.trigger).toBe(DEFAULT_ACTION_TRIGGER);
    expect(action.maxAttempts).toBe(DEFAULT_ACTION_MAX_ATTEMPTS);
    expect(action.archived).toBe(DEFAULT_ACTION_ARCHIVED);
    expect(action.dependsOn).toEqual([]);
    expect(action.attempts).toBe(0);
    expect(action.metadata.tags).toEqual([]);
    expect(action.executions).toEqual([]);
    expect(action.input).toBeUndefined();
  });

  it("derives a deterministic id from name/type/trigger/priority/createdAt", () => {
    const a = createAction(baseInput());
    const b = createAction(baseInput());
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^action-[0-9a-f]{8}$/);
  });

  it("honors an explicit id", () => {
    const action = createAction({ ...baseInput(), id: "action-1" });
    expect(action.id).toBe("action-1");
  });

  it("copies input, dependsOn, tags, and executions as new arrays/records", () => {
    const input = { query: "project" };
    const dependsOn = ["a", "b"];
    const tags = ["t"];
    const action = createAction({
      ...baseInput(),
      input,
      dependsOn,
      metadata: { tags },
    });
    expect(action.input).toEqual(input);
    expect(action.input).not.toBe(input);
    expect(action.dependsOn).not.toBe(dependsOn);
    expect(action.metadata.tags).not.toBe(tags);
  });

  it("stores links (conversationId, memoryId, jobId)", () => {
    const action = createAction({
      ...baseInput(),
      conversationId: "conv-1",
      memoryId: "mem-1",
      jobId: "job-1",
    });
    expect(action.conversationId).toBe("conv-1");
    expect(action.memoryId).toBe("mem-1");
    expect(action.jobId).toBe("job-1");
  });

  it("derives different ids for different types/names/times", () => {
    const a = createAction(baseInput());
    const b = createAction({ ...baseInput(), type: "search_calendar" });
    const c = createAction({ ...baseInput(), createdAt: "2026-08-11T00:00:00.000Z" });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });
});

describe("createActionExecution", () => {
  it("derives a deterministic execution id", () => {
    const input = { actionId: "action-1", attempt: 1, status: "running" as const, startedAt: NOW };
    expect(createActionExecution(input).id).toBe(createActionExecution(input).id);
    expect(createActionExecution(input).id).toMatch(/^exec-action-[0-9a-f]{8}$/);
  });

  it("copies error/result records", () => {
    const execution = createActionExecution({
      actionId: "action-1",
      attempt: 1,
      status: "completed" as const,
      startedAt: NOW,
      finishedAt: NOW,
      result: { success: true, output: { n: 1 } },
      durationMs: 10,
    });
    expect(execution.result).toEqual({ success: true, output: { n: 1 } });
    expect(execution.durationMs).toBe(10);
  });
});

describe("touchAction", () => {
  it("applies a patch preserving missing keys", () => {
    const action = createAction(baseInput());
    const updated = touchAction(action, { status: "running", startedAt: NOW });
    expect(updated.status).toBe("running");
    expect(updated.name).toBe(action.name);
    expect(updated.type).toBe(action.type);
    expect(updated.priority).toBe(action.priority);
  });

  it("clears optional fields with null", () => {
    const action = createAction({ ...baseInput(), error: { code: "x", message: "y" } });
    const cleared = touchAction(action, { error: null });
    expect(cleared.error).toBeUndefined();
  });

  it("copies input/dependsOn/tags/executions on patch", () => {
    const action = createAction(baseInput());
    const input = { query: "q" };
    const updated = touchAction(action, { input });
    expect(updated.input).toEqual(input);
    expect(updated.input).not.toBe(input);
  });

  it("does not mutate the source action", () => {
    const action = createAction(baseInput());
    touchAction(action, { status: "completed" });
    expect(action.status).toBe("pending");
  });
});

describe("cloneAction", () => {
  it("returns a deep, detached copy", () => {
    const action = createAction({
      ...baseInput(),
      input: { query: "x" },
      executions: [
        createActionExecution({
          actionId: "a",
          attempt: 1,
          status: "completed" as const,
          startedAt: NOW,
          result: { success: true },
        }),
      ],
    });
    const clone = cloneAction(action);
    expect(clone).toEqual(action);
    expect(clone).not.toBe(action);
    expect(clone.input).not.toBe(action.input);
    expect(clone.executions).not.toBe(action.executions);
    expect(clone.executions[0]).not.toBe(action.executions[0]);
  });

  it("mutating the clone never affects the source", () => {
    const action = createAction(baseInput());
    const clone = cloneAction(action);
    (clone as { name: string }).name = "Mutated";
    expect(action.name).toBe("Search Gmail");
  });
});

describe("freezeAction", () => {
  it("deep-freezes the action, metadata, input, executions, and dependsOn", () => {
    const action = createAction({
      ...baseInput(),
      input: { query: "x" },
      dependsOn: ["a"],
      metadata: { tags: ["t"] },
      executions: [
        createActionExecution({
          actionId: "a",
          attempt: 1,
          status: "running" as const,
          startedAt: NOW,
        }),
      ],
    });
    const frozen = freezeAction(action);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.metadata)).toBe(true);
    expect(Object.isFrozen(frozen.metadata.tags)).toBe(true);
    expect(Object.isFrozen(frozen.input)).toBe(true);
    expect(Object.isFrozen(frozen.dependsOn)).toBe(true);
    expect(Object.isFrozen(frozen.executions)).toBe(true);
    expect(Object.isFrozen(frozen.executions[0])).toBe(true);
  });
});

describe("scheduling predicates", () => {
  it("isActionDue requires pending, non-archived, and scheduledAt <= now", () => {
    const action = createAction({ ...baseInput(), scheduledAt: NOW });
    expect(isActionDue(action, NOW)).toBe(true);
    expect(isActionDue(action, "2026-08-10T11:00:00.000Z")).toBe(false);
    expect(isActionDue(touchAction(action, { status: "completed" }), NOW)).toBe(false);
    expect(isActionDue(touchAction(action, { archived: true }), NOW)).toBe(false);
  });

  it("isActionDue returns true for schedule-less pending actions", () => {
    const action = createAction(baseInput());
    expect(isActionDue(action, NOW)).toBe(true);
  });

  it("isActionRunnable is identical to isActionDue", () => {
    const action = createAction({ ...baseInput(), scheduledAt: NOW });
    expect(isActionRunnable(action, NOW)).toBe(isActionDue(action, NOW));
    expect(isActionRunnable(action, "2026-08-10T11:00:00.000Z")).toBe(false);
  });
});

describe("estimateActionCost", () => {
  it("uses explicit costUnits when set", () => {
    const action = createAction({ ...baseInput(), metadata: { costUnits: 42 } });
    expect(estimateActionCost(action)).toBe(42);
  });

  it("falls back to the priority base cost", () => {
    expect(estimateActionCost(createAction({ ...baseInput(), priority: "low" }))).toBe(
      PRIORITY_COST.low,
    );
    expect(estimateActionCost(createAction({ ...baseInput(), priority: "critical" }))).toBe(
      PRIORITY_COST.critical,
    );
  });
});

describe("projections", () => {
  it("createActionSummary projects the lightweight view", () => {
    const action = createAction({
      ...baseInput(),
      priority: "high",
      scheduledAt: NOW,
      attempts: 2,
      maxAttempts: 3,
      archived: true,
    });
    const summary = createActionSummary(action);
    expect(summary).toEqual({
      id: action.id,
      name: "Search Gmail",
      type: "search_gmail",
      status: "pending",
      priority: "high",
      trigger: "manual",
      createdAt: NOW,
      scheduledAt: NOW,
      attempts: 2,
      maxAttempts: 3,
      archived: true,
      costEstimate: PRIORITY_COST.high,
    });
  });

  it("createActionReference carries type and trigger", () => {
    const action = createAction(baseInput());
    const reference = createActionReference(action);
    expect(reference).toEqual({
      actionId: action.id,
      type: "search_gmail",
      trigger: "manual",
    });
  });

  it("createActionHistory returns a detached executions array", () => {
    const action = createAction({
      ...baseInput(),
      executions: [
        createActionExecution({
          actionId: "a",
          attempt: 1,
          status: "completed" as const,
          startedAt: NOW,
        }),
      ],
    });
    const history = createActionHistory(action);
    expect(history.actionId).toBe(action.id);
    expect(history.executions).toHaveLength(1);
    expect(history.executions).not.toBe(action.executions);
  });
});

describe("determinism", () => {
  it("hashAction is deterministic and FNV-1a-shaped", () => {
    expect(hashAction("abc")).toBe(hashAction("abc"));
    expect(hashAction("abc")).toMatch(/^[0-9a-f]{8}$/);
    expect(hashAction("abc")).not.toBe(hashAction("abd"));
  });

  it("identical inputs produce identical actions", () => {
    expect(createAction(baseInput())).toEqual(createAction(baseInput()));
  });

  it("no Date.now or Math.random leaks into the model layer", () => {
    // The action layer derives ids from contents only; two calls at different
    // wall-clock instants still produce identical results for identical input.
    const a = createAction(baseInput());
    const b = createAction(baseInput());
    expect(a).toEqual(b);
  });
});

describe("types", () => {
  it("PRIORITY_RANK orders critical > high > normal > low", () => {
    expect(PRIORITY_RANK.critical).toBeGreaterThan(PRIORITY_RANK.high);
    expect(PRIORITY_RANK.high).toBeGreaterThan(PRIORITY_RANK.normal);
    expect(PRIORITY_RANK.normal).toBeGreaterThan(PRIORITY_RANK.low);
  });

  it("ActionPatch is assignable from partial fields", () => {
    const patch: ActionPatch = { status: "running", input: null, dependsOn: ["x"] };
    expect(patch.status).toBe("running");
    expect(patch.input).toBeNull();
    expect(patch.dependsOn).toEqual(["x"]);
  });

  it("an Action is structurally assignable to its readonly model", () => {
    const action: Action = createAction(baseInput());
    expect(action.type).toBe("search_gmail");
  });
});
