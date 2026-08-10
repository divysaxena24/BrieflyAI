import { describe, expect, it } from "vitest";
import { ActionManager } from "@/lib/actions/manager";
import { ActionNotFoundError, ActionRepository } from "@/lib/actions/repository";
import { createAction, type Action } from "@/lib/actions/types";

const NOW = "2026-08-10T12:00:00.000Z";
const LATER = "2026-08-10T13:00:00.000Z";

function input(overrides: Partial<Parameters<ActionManager["createAction"]>[0]> = {}) {
  return {
    name: "Search Gmail",
    type: "search_gmail" as const,
    createdAt: NOW,
    ...overrides,
  };
}

function stored(): Action {
  return createAction(input({ id: "action-1" }));
}

describe("ActionManager basics", () => {
  it("starts empty and exposes its repository readonly", () => {
    const manager = new ActionManager();
    expect(manager.count()).toBe(0);
    expect(manager.repository).toBeInstanceOf(ActionRepository);
  });

  it("find/list/has/count delegate to the repository", () => {
    const manager = new ActionManager(new ActionRepository([stored()]));
    expect(manager.count()).toBe(1);
    expect(manager.has("action-1")).toBe(true);
    expect(manager.find("action-1")?.name).toBe("Search Gmail");
    expect(manager.find("missing")).toBeUndefined();
    expect(manager.list()).toHaveLength(1);
  });
});

describe("ActionManager lifecycle", () => {
  it("createAction stores a new action and returns the successor manager", () => {
    const manager = new ActionManager();
    const { manager: next, action } = manager.createAction(input());
    expect(next.count()).toBe(1);
    expect(manager.count()).toBe(0); // receiver never mutated
    expect(action.status).toBe("pending");
  });

  it("scheduleAction is an explicit alias of createAction", () => {
    const manager = new ActionManager();
    const { manager: next, action } = manager.scheduleAction(input({ scheduledAt: NOW }));
    expect(next.has(action.id)).toBe(true);
    expect(action.scheduledAt).toBe(NOW);
  });

  it("createAction throws for duplicate ids", () => {
    const manager = new ActionManager(new ActionRepository([stored()]));
    expect(() => manager.createAction(input({ id: "action-1" }))).toThrow();
  });

  it("executeAction marks running, increments attempts, appends a running execution", () => {
    const manager = new ActionManager(new ActionRepository([stored()]));
    const { manager: next, action, execution } = manager.executeAction("action-1", { at: NOW });
    expect(action.status).toBe("running");
    expect(action.attempts).toBe(1);
    expect(action.startedAt).toBe(NOW);
    expect(action.executions).toHaveLength(1);
    expect(execution.status).toBe("running");
    expect(next.find("action-1")?.status).toBe("running");
    expect(manager.find("action-1")?.status).toBe("pending"); // receiver unchanged
  });

  it("completeAction finalizes the running execution as completed", () => {
    let manager = new ActionManager(new ActionRepository([stored()]));
    manager = manager.executeAction("action-1", { at: NOW }).manager;
    const { manager: next, action } = manager.completeAction("action-1", {
      at: LATER,
      attempt: 1,
      output: { messages: [] },
      durationMs: 5,
    });
    expect(action.status).toBe("completed");
    expect(action.completedAt).toBe(LATER);
    expect(action.result).toEqual({
      success: true,
      output: { messages: [] },
      durationMs: 5,
    });
    expect(action.executions[0].status).toBe("completed");
    expect(action.executions[0].finishedAt).toBe(LATER);
    expect(next.find("action-1")?.status).toBe("completed");
  });

  it("failAction finalizes the running execution as failed with the error", () => {
    let manager = new ActionManager(new ActionRepository([stored()]));
    manager = manager.executeAction("action-1", { at: NOW }).manager;
    const { action } = manager.failAction("action-1", {
      at: LATER,
      attempt: 1,
      error: { code: "handler_error", message: "boom" },
    });
    expect(action.status).toBe("failed");
    expect(action.error).toEqual({ code: "handler_error", message: "boom" });
    expect(action.executions[0].status).toBe("failed");
  });

  it("cancelAction finalizes the running execution as cancelled", () => {
    let manager = new ActionManager(new ActionRepository([stored()]));
    manager = manager.executeAction("action-1", { at: NOW }).manager;
    const { action } = manager.cancelAction("action-1", {
      at: LATER,
      error: { code: "cancelled", message: "user" },
    });
    expect(action.status).toBe("cancelled");
    expect(action.executions[0].status).toBe("cancelled");
  });

  it("settling without executeAction appends a finalized execution", () => {
    const manager = new ActionManager(new ActionRepository([stored()]));
    const { action } = manager.completeAction("action-1", { at: NOW, attempt: 1 });
    expect(action.status).toBe("completed");
    expect(action.executions).toHaveLength(1);
  });

  it("lifecycle methods throw ActionNotFoundError for unknown ids", () => {
    const manager = new ActionManager();
    expect(() => manager.executeAction("missing", { at: NOW })).toThrow(ActionNotFoundError);
    expect(() => manager.completeAction("missing", { at: NOW })).toThrow(ActionNotFoundError);
    expect(() => manager.failAction("missing", { at: NOW, error: { code: "x", message: "y" } })).toThrow(
      ActionNotFoundError,
    );
    expect(() => manager.cancelAction("missing", { at: NOW })).toThrow(ActionNotFoundError);
  });
});

describe("ActionManager retry/archive/restore/delete", () => {
  it("retryAction re-enables failed/cancelled actions and is a no-op otherwise", () => {
    let manager = new ActionManager(new ActionRepository([stored()]));
    manager = manager.executeAction("action-1", { at: NOW }).manager;
    manager = manager.failAction("action-1", {
      at: NOW,
      error: { code: "handler_error", message: "boom" },
    }).manager;
    const { manager: retried, action } = manager.retryAction("action-1");
    expect(action.status).toBe("pending");
    expect(action.error).toBeUndefined();
    expect(retried.find("action-1")?.status).toBe("pending");

    // A completed action is returned unchanged (no-op).
    let completed = new ActionManager(new ActionRepository([stored()]));
    completed = completed.executeAction("action-1", { at: NOW }).manager;
    completed = completed.completeAction("action-1", { at: NOW }).manager;
    const { action: unchanged } = completed.retryAction("action-1");
    expect(unchanged.status).toBe("completed");
    expect(completed.find("action-1")?.status).toBe("completed");
  });

  it("archiveAction/restoreAction toggle the archived flag", () => {
    const manager = new ActionManager(new ActionRepository([stored()]));
    const archived = manager.archiveAction("action-1");
    expect(archived.find("action-1")?.archived).toBe(true);
    const restored = archived.restoreAction("action-1");
    expect(restored.find("action-1")?.archived).toBe(false);
    expect(manager.find("action-1")?.archived).toBe(false);
  });

  it("deleteAction removes the action entirely", () => {
    const manager = new ActionManager(new ActionRepository([stored(), createAction(input({ id: "action-2", name: "B" }))]));
    const next = manager.deleteAction("action-1");
    expect(next.count()).toBe(1);
    expect(next.has("action-1")).toBe(false);
    expect(() => manager.deleteAction("missing")).toThrow(ActionNotFoundError);
  });

  it("archive/restore/delete throw ActionNotFoundError for unknown ids", () => {
    const manager = new ActionManager();
    expect(() => manager.archiveAction("missing")).toThrow(ActionNotFoundError);
    expect(() => manager.restoreAction("missing")).toThrow(ActionNotFoundError);
    expect(() => manager.deleteAction("missing")).toThrow(ActionNotFoundError);
  });
});

describe("ActionManager bulk operations", () => {
  it("bulkCreate stores many actions atomically", () => {
    const manager = new ActionManager();
    const { manager: next, actions } = manager.bulkCreate([
      input({ id: "action-1" }),
      input({ id: "action-2", name: "B", type: "search_calendar" }),
    ]);
    expect(actions).toHaveLength(2);
    expect(next.count()).toBe(2);
    expect(manager.count()).toBe(0);
  });

  it("bulkCreate throws on the first duplicate and never mutates the receiver", () => {
    const manager = new ActionManager(new ActionRepository([stored()]));
    expect(() =>
      manager.bulkCreate([input({ id: "action-1" }), input({ id: "action-2" })]),
    ).toThrow();
    expect(manager.count()).toBe(1);
  });

  it("bulkCancel cancels many actions and throws on unknown ids", () => {
    let manager = new ActionManager(
      new ActionRepository([
        stored(),
        createAction(input({ id: "action-2", name: "B" })),
      ]),
    );
    manager = manager.bulkCancel(["action-1", "action-2"]);
    expect(manager.find("action-1")?.status).toBe("cancelled");
    expect(manager.find("action-2")?.status).toBe("cancelled");

    const fresh = new ActionManager(new ActionRepository([stored()]));
    expect(() => fresh.bulkCancel(["action-1", "missing"])).toThrow(ActionNotFoundError);
    expect(fresh.count()).toBe(1);
  });
});

describe("ActionManager determinism & scale", () => {
  it("is deterministic for identical sequences", () => {
    const build = (): ActionManager => {
      let manager = new ActionManager();
      manager = manager.createAction(input({ id: "a" })).manager;
      manager = manager.executeAction("a", { at: NOW }).manager;
      manager = manager.completeAction("a", { at: LATER, output: 1 }).manager;
      return manager;
    };
    expect(build().list()).toEqual(build().list());
  });

  it("handles 1000 actions", () => {
    let manager = new ActionManager();
    const inputs = [];
    for (let index = 0; index < 1000; index += 1) {
      inputs.push(input({ id: `action-${index}`, name: `Action ${index}` }));
    }
    manager = manager.bulkCreate(inputs).manager;
    expect(manager.count()).toBe(1000);
    const cancelled = manager.bulkCancel(inputs.map((x) => x.id));
    expect(cancelled.repository.findByStatus("cancelled").length).toBe(1000);
  });

  it("repository is immutable: reads return detached clones", () => {
    const manager = new ActionManager(new ActionRepository([stored()]));
    const listed = manager.list();
    (listed[0] as { name: string }).name = "Mutated";
    expect(manager.find("action-1")?.name).toBe("Search Gmail");
  });
});
