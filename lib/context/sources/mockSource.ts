/**
 * Context Engine — mock context source.
 *
 * Test double for `ContextSource` used in tests and prototypes. Returns a deep
 * clone of its configured contexts on every `retrieve()` call, so callers can
 * mutate results without affecting the source's internal data.
 */

import { ContextSourceBase } from "./contextSource";
import type { Context } from "@/lib/context/types";

/**
 * A configurable `ContextSource` for tests and prototypes.
 */
export class MockContextSource extends ContextSourceBase {
  private readonly contexts: Context[];
  private readonly available: boolean;

  /**
   * @param id Unique source id.
   * @param priority Default ranking weight.
   * @param contexts Contexts returned (cloned) by `retrieve()`.
   * @param available Controls the `isAvailable()` result (defaults to true).
   */
  constructor(id: string, priority: number, contexts: Context[], available = true) {
    super(id, priority);
    this.contexts = contexts;
    this.available = available;
  }

  /** Returns the configured availability flag. */
  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  /** Returns a deep clone of the configured contexts. Never mutates internals. */
  async retrieve(): Promise<Context[]> {
    return structuredClone(this.contexts);
  }
}
