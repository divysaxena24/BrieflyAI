import { describe, expect, it } from "vitest";
import {
  ActionDuplicateError,
  ActionNotFoundError,
  ActionRepository,
} from "@/lib/actions/repository";
import { createAction, type Action } from "@/lib/actions/types";

const NOW = "2026-08-10T12:00:00.000Z";

function action(overrides: Partial<Parameters<typeof createAction>[0]> = {}): Action {
  return createAction({
    name: "Search Gmail",
    type: "search_gmail",
    createdAt: NOW,
    ...overrides,
  });
}

describe("ActionRepository construction", () => {
  it("starts empty by default", () => {
    const repository = new ActionRepository();
    expect(repository.count()).toBe(0);
    expect(repository.list()).toEqual([]);
  });

  it("snapshots the initial actions (later mutation never leaks in)", () => {
    const source = action();
    const repository = new ActionRepository([source]);
    (source as { name: string }).name = "Mutated";
    expect(repository.list()[0].name).toBe("Search Gmail");
  });

  it("stores frozen, detached clones", () => {
    const repository = new ActionRepository([action()]);
    const listed = repository.list();
    expect(Object.isFrozen(repository.find(listed[0].id) as Action)).toBe(false); // reads are clones
    expect(listed[0]).not.toBe(repository.find(listed[0].id));
  });
});

describe("ActionRepository mutations", () => {
  it("add appends and returns the stored action plus the successor", () => {
    const repository = new ActionRepository();
    const first = action();
    const { action: stored, repository: next } = repository.add(first);
    expect(next.count()).toBe(1);
    expect(repository.count()).toBe(0); // receiver never mutated
    expect(stored).toEqual(first);
  });

  it("add throws ActionDuplicateError for an already-stored id", () => {
    const repository = new ActionRepository([action()]);
    expect(() => repository.add(action())).toThrow(ActionDuplicateError);
  });

  it("update patches by id preserving position", () => {
    const a = action({ id: "action-a", name: "A" });
    const b = action({ id: "action-b", name: "B" });
    const repository = new ActionRepository([a, b]);
    const { action: updated, repository: next } = repository.update("action-a", {
      status: "completed",
    });
    expect(updated.status).toBe("completed");
    expect(next.list().map((x) => x.id)).toEqual(["action-a", "action-b"]);
    expect(next.list()[0].status).toBe("completed");
    expect(repository.list()[0].status).toBe("pending"); // receiver unchanged
  });

  it("update throws ActionNotFoundError for unknown ids", () => {
    const repository = new ActionRepository();
    expect(() => repository.update("missing", { status: "completed" })).toThrow(
      ActionNotFoundError,
    );
  });

  it("replace swaps the stored action keeping position", () => {
    const a = action({ id: "action-a", name: "A" });
    const b = action({ id: "action-b", name: "B" });
    const replacement = createAction({ name: "Replacement", type: "search_gmail", createdAt: NOW, id: "action-a" });
    const repository = new ActionRepository([a, b]);
    const next = repository.replace(replacement);
    expect(next.list().map((x) => x.id)).toEqual(["action-a", "action-b"]);
    expect(next.list()[0].name).toBe("Replacement");
  });

  it("replace throws ActionNotFoundError for unknown ids", () => {
    const repository = new ActionRepository();
    expect(() => repository.replace(action())).toThrow(ActionNotFoundError);
  });

  it("remove deletes by id and throws for unknown ids", () => {
    const repository = new ActionRepository([action({ id: "action-a" }), action({ id: "action-b" })]);
    const next = repository.remove("action-a");
    expect(next.list().map((x) => x.id)).toEqual(["action-b"]);
    expect(() => repository.remove("missing")).toThrow(ActionNotFoundError);
  });

  it("clear returns an empty repository without touching the receiver", () => {
    const repository = new ActionRepository([action(), action({ id: "x", name: "X" })]);
    const cleared = repository.clear();
    expect(cleared.count()).toBe(0);
    expect(repository.count()).toBe(2);
  });
});

describe("ActionRepository queries", () => {
  const repository = new ActionRepository([
    action({ id: "a1", name: "A1", type: "search_gmail", status: "pending", priority: "high", conversationId: "conv-1" }),
    action({ id: "a2", name: "A2", type: "search_calendar", status: "completed", priority: "low", conversationId: "conv-1", memoryId: "mem-1" }),
    action({ id: "a3", name: "A3", type: "create_memory", status: "pending", priority: "normal", jobId: "job-1" }),
    action({ id: "a4", name: "A4", type: "run_job", status: "pending", priority: "critical", jobId: "job-1" }),
  ]);

  it("find returns a detached clone or undefined", () => {
    const found = repository.find("a1");
    expect(found?.id).toBe("a1");
    expect(repository.find("missing")).toBeUndefined();
  });

  it("findByStatus filters by status in order", () => {
    expect(repository.findByStatus("pending").map((x) => x.id)).toEqual(["a1", "a3", "a4"]);
    expect(repository.findByStatus("completed").map((x) => x.id)).toEqual(["a2"]);
  });

  it("findByType filters by type in order", () => {
    expect(repository.findByType("search_gmail").map((x) => x.id)).toEqual(["a1"]);
    expect(repository.findByType("run_job").map((x) => x.id)).toEqual(["a4"]);
  });

  it("findByPriority filters by priority in order", () => {
    expect(repository.findByPriority("critical").map((x) => x.id)).toEqual(["a4"]);
    expect(repository.findByPriority("low").map((x) => x.id)).toEqual(["a2"]);
  });

  it("findByConversation filters by linked conversation", () => {
    expect(repository.findByConversation("conv-1").map((x) => x.id)).toEqual(["a1", "a2"]);
    expect(repository.findByConversation("conv-x")).toEqual([]);
  });

  it("findByMemory filters by linked memory", () => {
    expect(repository.findByMemory("mem-1").map((x) => x.id)).toEqual(["a2"]);
  });

  it("findByJob filters by linked job", () => {
    expect(repository.findByJob("job-1").map((x) => x.id)).toEqual(["a3", "a4"]);
  });

  it("findRunnableActions returns pending, non-archived, due actions", () => {
    const runnable = repository.findRunnableActions(NOW).map((x) => x.id);
    expect(runnable).toEqual(["a1", "a3", "a4"]);
  });

  it("has and count reflect storage", () => {
    expect(repository.has("a1")).toBe(true);
    expect(repository.has("missing")).toBe(false);
    expect(repository.count()).toBe(4);
  });
});

describe("ActionRepository scale & determinism", () => {
  it("handles 1000 actions", () => {
    let repository = new ActionRepository();
    for (let index = 0; index < 1000; index += 1) {
      repository = repository.add(
        action({ id: `action-${index}`, name: `Action ${index}`, createdAt: NOW }),
      ).repository;
    }
    expect(repository.count()).toBe(1000);
    expect(repository.find("action-999")?.name).toBe("Action 999");
    expect(repository.list().length).toBe(1000);
  });

  it("is deterministic: identical sequences yield identical states", () => {
    const build = (): ActionRepository => {
      let repository = new ActionRepository();
      repository = repository.add(action({ id: "a", name: "A" })).repository;
      repository = repository.add(action({ id: "b", name: "B" })).repository;
      repository = repository.update("a", { status: "completed" }).repository;
      return repository;
    };
    expect(build().list()).toEqual(build().list());
  });
});
