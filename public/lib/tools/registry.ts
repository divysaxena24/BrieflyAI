/**
 * AI Tool layer — tool registry.
 *
 * Owns the set of registered tools. The registry is immutable: `register`
 * and `unregister` return a *new* registry rather than mutating the current
 * one, and `list()` exposes a snapshot. No global mutable state — instances
 * are created and injected by the caller (no singletons).
 *
 * Determinism: `list()` returns tools in registration order, and a registry
 * built from the same tools in the same order behaves identically.
 */

import type { Tool } from "./types";

/**
 * Immutable collection of registered tools.
 *
 * Construct with an initial tool list (duplicate ids throw), then use
 * `register` / `unregister` for functional updates.
 */
export class ToolRegistry {
  private readonly tools: ReadonlyMap<string, Tool>;

  constructor(tools: readonly Tool[] = []) {
    const map = new Map<string, Tool>();
    for (const tool of tools) {
      if (map.has(tool.id)) {
        throw new Error(`Tool registry already contains tool "${tool.id}"`);
      }
      map.set(tool.id, tool);
    }
    this.tools = map;
  }

  /**
   * Return a new registry with `tool` added.
   *
   * Throws when a tool with the same id is already registered. The current
   * registry is never mutated.
   */
  register(tool: Tool): ToolRegistry {
    if (this.tools.has(tool.id)) {
      throw new Error(`Tool registry already contains tool "${tool.id}"`);
    }
    return new ToolRegistry([...this.tools.values(), tool]);
  }

  /**
   * Return a new registry without the tool `toolId` (a no-op returning the
   * same registry when no such tool is registered). Never mutates `this`.
   */
  unregister(toolId: string): ToolRegistry {
    if (!this.tools.has(toolId)) return this;
    return new ToolRegistry([...this.tools.values()].filter((tool) => tool.id !== toolId));
  }

  /** Look up a tool by id; `undefined` when not registered. */
  get(toolId: string): Tool | undefined {
    return this.tools.get(toolId);
  }

  /** Whether a tool with `toolId` is registered. */
  has(toolId: string): boolean {
    return this.tools.has(toolId);
  }

  /** Snapshot of the registered tools in registration order. */
  list(): readonly Tool[] {
    return [...this.tools.values()];
  }
}
