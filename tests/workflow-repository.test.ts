import { describe, expect, it } from "vitest";
import {
  WorkflowDuplicateError,
  WorkflowNotFoundError,
  WorkflowRepository,
} from "@/lib/workflows/repository";
import {
  createWorkflow,
  createWorkflowStep,
  type Workflow,
  type WorkflowStep,
} from "@/lib/workflows/types";

const NOW = "2026-08-10T12:00:00.000Z";

function step(id: string, dependsOn: readonly string[] = []): WorkflowStep {
  return createWorkflowStep({ id, name: `Step ${id}`, action: { kind: "job", jobId: "job-1" }, dependsOn });
}

function makeWorkflow(id: string, overrides: Partial<Parameters<typeof createWorkflow>[0]> = {}): Workflow {
  return createWorkflow({
    id,
    name: `Workflow ${id}`,
    createdAt: NOW,
    steps: [step("s1")],
    ...overrides,
  });
}

describe("WorkflowRepository construction", () => {
  it("starts empty by default", () => {
    const repository = new WorkflowRepository();
    expect(repository.count()).toBe(0);
    expect(repository.list()).toEqual([]);
  });

  it("snapshots initial workflows (detached)", () => {
    const input = makeWorkflow("w1");
    const repository = new WorkflowRepository([input]);
    (input as { name: string }).name = "Mutated";
    expect(repository.find("w1")?.name).toBe("Workflow w1");
  });
});

describe("WorkflowRepository mutations", () => {
  it("add returns the stored workflow plus a successor repository", () => {
    const repository = new WorkflowRepository();
    const { workflow, repository: next } = repository.add(makeWorkflow("w1"));
    expect(workflow.id).toBe("w1");
    expect(next.count()).toBe(1);
    expect(repository.count()).toBe(0);
  });

  it("add throws WorkflowDuplicateError for existing ids", () => {
    const repository = new WorkflowRepository([makeWorkflow("w1")]);
    expect(() => repository.add(makeWorkflow("w1"))).toThrow(WorkflowDuplicateError);
  });

  it("update applies a patch and preserves position", () => {
    const repository = new WorkflowRepository([makeWorkflow("w1"), makeWorkflow("w2")]);
    const { workflow, repository: next } = repository.update("w1", { enabled: false });
    expect(workflow.enabled).toBe(false);
    expect(next.list().map((w) => w.id)).toEqual(["w1", "w2"]);
  });

  it("update throws WorkflowNotFoundError for unknown ids", () => {
    const repository = new WorkflowRepository();
    expect(() => repository.update("missing", { status: "completed" })).toThrow(
      WorkflowNotFoundError,
    );
  });

  it("replace keeps insertion position", () => {
    const repository = new WorkflowRepository([makeWorkflow("w1"), makeWorkflow("w2")]);
    const next = repository.replace(makeWorkflow("w1", { enabled: false }));
    expect(next.list().map((w) => w.id)).toEqual(["w1", "w2"]);
    expect(next.find("w1")?.enabled).toBe(false);
  });

  it("remove deletes the workflow and returns a successor", () => {
    const repository = new WorkflowRepository([makeWorkflow("w1"), makeWorkflow("w2")]);
    const next = repository.remove("w1");
    expect(next.count()).toBe(1);
    expect(repository.count()).toBe(2);
    expect(() => repository.remove("missing")).toThrow(WorkflowNotFoundError);
  });

  it("clear returns an empty repository without touching the receiver", () => {
    const repository = new WorkflowRepository([makeWorkflow("w1")]);
    const cleared = repository.clear();
    expect(cleared.count()).toBe(0);
    expect(repository.count()).toBe(1);
  });
});

describe("WorkflowRepository queries", () => {
  it("find returns a detached clone", () => {
    const repository = new WorkflowRepository([makeWorkflow("w1")]);
    const found = repository.find("w1");
    expect(found?.id).toBe("w1");
    (found as { name: string }).name = "Mutated";
    expect(repository.find("w1")?.name).toBe("Workflow w1");
  });

  it("findByStatus filters by status", () => {
    const repository = new WorkflowRepository([
      makeWorkflow("w1"),
      makeWorkflow("w2", { status: "completed" }),
    ]);
    expect(repository.findByStatus("pending").map((w) => w.id)).toEqual(["w1"]);
    expect(repository.findByStatus("completed").map((w) => w.id)).toEqual(["w2"]);
  });

  it("findByPriority filters by priority", () => {
    const repository = new WorkflowRepository([
      makeWorkflow("w1", { priority: "high" }),
      makeWorkflow("w2"),
    ]);
    expect(repository.findByPriority("high").map((w) => w.id)).toEqual(["w1"]);
  });

  it("findByTrigger filters by trigger kind", () => {
    const repository = new WorkflowRepository([
      makeWorkflow("w1", { trigger: { kind: "scheduled", schedule: { at: NOW } } }),
      makeWorkflow("w2"),
    ]);
    expect(repository.findByTrigger("scheduled").map((w) => w.id)).toEqual(["w1"]);
  });

  it("findByConversation / findByMemory / findByJob / findByDigest filter links", () => {
    const repository = new WorkflowRepository([
      makeWorkflow("w1", { conversationId: "conv-1", memoryId: "mem-1" }),
      makeWorkflow("w2", { jobId: "job-1", digestId: "dig-1" }),
    ]);
    expect(repository.findByConversation("conv-1").map((w) => w.id)).toEqual(["w1"]);
    expect(repository.findByMemory("mem-1").map((w) => w.id)).toEqual(["w1"]);
    expect(repository.findByJob("job-1").map((w) => w.id)).toEqual(["w2"]);
    expect(repository.findByDigest("dig-1").map((w) => w.id)).toEqual(["w2"]);
  });

  it("findRunnableWorkflows returns pending, enabled, due workflows", () => {
    const repository = new WorkflowRepository([
      makeWorkflow("w1"), // no schedule → runnable while pending
      makeWorkflow("w2", { status: "completed" }),
      makeWorkflow("w3", { archived: true }),
      makeWorkflow("w4", { enabled: false }),
      makeWorkflow("w5", {
        trigger: { kind: "scheduled", schedule: { at: NOW } },
      }),
      makeWorkflow("w6", {
        trigger: { kind: "scheduled", schedule: { at: "2026-08-11T00:00:00.000Z" } },
      }),
    ]);
    const runnable = repository.findRunnableWorkflows(NOW).map((w) => w.id);
    expect(runnable).toContain("w1");
    expect(runnable).toContain("w5");
    expect(runnable).not.toContain("w2");
    expect(runnable).not.toContain("w3");
    expect(runnable).not.toContain("w4");
    expect(runnable).not.toContain("w6");
  });

  it("has and count reflect stored workflows", () => {
    const repository = new WorkflowRepository([makeWorkflow("w1")]);
    expect(repository.has("w1")).toBe(true);
    expect(repository.has("missing")).toBe(false);
    expect(repository.count()).toBe(1);
  });
});

describe("WorkflowRepository immutability", () => {
  it("reads return detached clones that never reach the internal store", () => {
    const repository = new WorkflowRepository([makeWorkflow("w1")]);
    const found = repository.find("w1") as Workflow;
    expect(found).toEqual(makeWorkflow("w1"));
    (found as { name: string }).name = "Mutated";
    expect(repository.find("w1")?.name).toBe("Workflow w1");
  });

  it("1000-workflow scale stays deterministic", () => {
    let repository = new WorkflowRepository();
    const ids: string[] = [];
    for (let index = 0; index < 1000; index += 1) {
      const createdAt = new Date(Date.parse(NOW) + index * 1000).toISOString();
      const { workflow, repository: next } = repository.add(
        createWorkflow({
          id: `w-${index}`,
          name: `W${index}`,
          createdAt,
          steps: [step("s1")],
        }),
      );
      ids.push(workflow.id);
      repository = next;
    }
    expect(repository.count()).toBe(1000);
    expect(repository.list().map((w) => w.id)).toEqual(ids);
    expect(repository.findRunnableWorkflows(NOW)).toHaveLength(1000);
  });
});
