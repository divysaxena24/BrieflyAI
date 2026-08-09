import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "@/lib/tools/registry";
import type { Tool } from "@/lib/tools/types";

/** Build a minimal valid tool with an accepting schema. */
function makeTool(id: string): Tool {
  return {
    id,
    description: `Tool ${id}`,
    inputSchema: z.unknown(),
    execute: async () => ({ ok: true }),
  };
}

describe("ToolRegistry construction", () => {
  it("starts empty", () => {
    expect(new ToolRegistry().list()).toEqual([]);
  });

  it("constructs from an initial tool list", () => {
    const registry = new ToolRegistry([makeTool("a"), makeTool("b")]);
    expect(registry.list().map((tool) => tool.id)).toEqual(["a", "b"]);
  });

  it("throws on duplicate ids at construction", () => {
    expect(() => new ToolRegistry([makeTool("a"), makeTool("a")])).toThrow(/already contains/);
  });
});

describe("ToolRegistry lookup", () => {
  it("finds a registered tool by id", () => {
    const registry = new ToolRegistry([makeTool("a")]);
    expect(registry.get("a")?.id).toBe("a");
  });

  it("returns undefined for an unknown id", () => {
    expect(new ToolRegistry().get("missing")).toBeUndefined();
  });

  it("reports membership with has", () => {
    const registry = new ToolRegistry([makeTool("a")]);
    expect(registry.has("a")).toBe(true);
    expect(registry.has("missing")).toBe(false);
  });

  it("lists tools in registration order (deterministic)", () => {
    const registry = new ToolRegistry([makeTool("c"), makeTool("a"), makeTool("b")]);
    expect(registry.list().map((tool) => tool.id)).toEqual(["c", "a", "b"]);
  });

  it("preserves output schema discovery metadata", () => {
    const tool: Tool = {
      id: "typed",
      description: "Typed tool",
      inputSchema: z.unknown(),
      outputSchema: z.object({ value: z.number() }),
      execute: async () => ({ value: 1 }),
    };
    const registry = new ToolRegistry([tool]);
    const stored = registry.get("typed");
    expect(stored?.outputSchema?.safeParse({ value: 1 }).success).toBe(true);
    expect(stored?.outputSchema?.safeParse({ value: "x" }).success).toBe(false);
  });
});

describe("ToolRegistry register", () => {
  it("returns a new registry with the added tool", () => {
    const original = new ToolRegistry([makeTool("a")]);
    const next = original.register(makeTool("b"));
    expect(next.has("b")).toBe(true);
    expect(next.get("b")?.id).toBe("b");
  });

  it("does not mutate the original registry (immutable)", () => {
    const original = new ToolRegistry([makeTool("a")]);
    original.register(makeTool("b"));
    expect(original.has("b")).toBe(false);
    expect(original.list().map((tool) => tool.id)).toEqual(["a"]);
  });

  it("throws when registering a duplicate id", () => {
    const registry = new ToolRegistry([makeTool("a")]);
    expect(() => registry.register(makeTool("a"))).toThrow(/already contains/);
  });
});

describe("ToolRegistry unregister", () => {
  it("returns a new registry without the removed tool", () => {
    const registry = new ToolRegistry([makeTool("a"), makeTool("b")]);
    const next = registry.unregister("a");
    expect(next.has("a")).toBe(false);
    expect(next.list().map((tool) => tool.id)).toEqual(["b"]);
  });

  it("does not mutate the original registry (immutable)", () => {
    const original = new ToolRegistry([makeTool("a"), makeTool("b")]);
    original.unregister("a");
    expect(original.has("a")).toBe(true);
  });

  it("is a no-op returning the same registry for an unknown id", () => {
    const registry = new ToolRegistry([makeTool("a")]);
    expect(registry.unregister("missing")).toBe(registry);
  });
});

describe("ToolRegistry determinism", () => {
  it("builds identical registries from the same tools in the same order", () => {
    const tools = [makeTool("a"), makeTool("b")];
    const first = new ToolRegistry(tools);
    const second = new ToolRegistry(tools);
    expect(first.list().map((tool) => tool.id)).toEqual(second.list().map((tool) => tool.id));
  });
});
