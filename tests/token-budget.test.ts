import { describe, it, expect } from "vitest";
import {
  DEFAULT_RESERVED_RATIO,
  DEFAULT_SOURCE_WEIGHTS,
  estimateTokens,
  calculateBudget,
  reallocateBudget,
  trimToBudget,
} from "@/lib/context/tokenBudget";

describe("estimateTokens", () => {
  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns 1 for a single character", () => {
    expect(estimateTokens("a")).toBe(1);
  });

  it("rounds partial tokens up", () => {
    expect(estimateTokens("abc")).toBe(1); // ceil(3 / 4)
    expect(estimateTokens("abcd")).toBe(1); // ceil(4 / 4)
    expect(estimateTokens("abcde")).toBe(2); // ceil(5 / 4)
  });

  it("estimates large strings as length / 4 rounded up", () => {
    expect(estimateTokens("x".repeat(1000))).toBe(250);
    expect(estimateTokens("x".repeat(1001))).toBe(251);
  });

  it("never returns a negative number", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("calculateBudget", () => {
  const budget = calculateBudget(8000);

  it("reports the context window as totalBudget", () => {
    expect(budget.totalBudget).toBe(8000);
  });

  it("computes reservedBudget as floor(window * DEFAULT_RESERVED_RATIO)", () => {
    expect(DEFAULT_RESERVED_RATIO).toBe(0.15);
    expect(budget.reservedBudget).toBe(Math.floor(8000 * 0.15));
    expect(budget.reservedBudget).toBe(1200);
  });

  it("computes availableBudget as window minus reserved", () => {
    expect(budget.availableBudget).toBe(8000 - 1200);
    expect(budget.availableBudget).toBe(6800);
  });

  it("does not allocate the reserved source", () => {
    expect(budget.perSourceBudget.reserved).toBeUndefined();
  });

  it("allocates every allocatable source", () => {
    expect(Object.keys(budget.perSourceBudget).sort()).toEqual(
      ["calendar", "drive", "gmail", "github", "memory", "messaging"].sort(),
    );
  });

  it("sum of allocations equals the available budget", () => {
    const sum = Object.values(budget.perSourceBudget).reduce((a, b) => a + b, 0);
    expect(sum).toBe(budget.availableBudget);
  });

  it("memory receives the flooring remainder", () => {
    // github/gmail/messaging each get floor(6800 * 0.20 / 0.95) = 1431
    expect(budget.perSourceBudget.github).toBe(1431);
    expect(budget.perSourceBudget.gmail).toBe(1431);
    expect(budget.perSourceBudget.messaging).toBe(1431);
    // calendar/drive each get floor(6800 * 0.05 / 0.95) = 357
    expect(budget.perSourceBudget.calendar).toBe(357);
    expect(budget.perSourceBudget.drive).toBe(357);
    // memory = floor share 1789 + remainder 4
    expect(budget.perSourceBudget.memory).toBe(1793);
  });

  it("handles a zero context window", () => {
    const zero = calculateBudget(0);
    expect(zero.totalBudget).toBe(0);
    expect(zero.reservedBudget).toBe(0);
    expect(zero.availableBudget).toBe(0);
    expect(Object.values(zero.perSourceBudget).every((value) => value === 0)).toBe(true);
  });

  it("leaves the exported weight constants frozen and intact", () => {
    expect(Object.isFrozen(DEFAULT_SOURCE_WEIGHTS)).toBe(true);
    expect(DEFAULT_SOURCE_WEIGHTS.memory).toBe(0.25);
    expect(DEFAULT_SOURCE_WEIGHTS.github).toBe(0.2);
    expect(DEFAULT_SOURCE_WEIGHTS.gmail).toBe(0.2);
    expect(DEFAULT_SOURCE_WEIGHTS.messaging).toBe(0.2);
    expect(DEFAULT_SOURCE_WEIGHTS.calendar).toBe(0.05);
    expect(DEFAULT_SOURCE_WEIGHTS.drive).toBe(0.05);
    expect(DEFAULT_SOURCE_WEIGHTS.reserved).toBe(0.05);
  });
});

describe("reallocateBudget", () => {
  const base = calculateBudget(8000);

  it("keeps the full allocation when every source is connected", () => {
    const all = reallocateBudget(base, [
      "memory",
      "github",
      "gmail",
      "messaging",
      "calendar",
      "drive",
    ]);
    expect(all.perSourceBudget).toEqual(base.perSourceBudget);
  });

  it("redistributes donated budget proportionally for partial connections", () => {
    const partial = reallocateBudget(base, ["memory", "gmail"]);
    // memory: floor(6800 * 0.25 / 0.45) = 3777 + remainder 1
    expect(partial.perSourceBudget.memory).toBe(3778);
    // gmail: floor(6800 * 0.20 / 0.45) = 3022
    expect(partial.perSourceBudget.gmail).toBe(3022);
    // disconnected sources receive nothing
    expect(partial.perSourceBudget.github).toBe(0);
    expect(partial.perSourceBudget.messaging).toBe(0);
    expect(partial.perSourceBudget.calendar).toBe(0);
    expect(partial.perSourceBudget.drive).toBe(0);
    // the donated budget is fully redistributed
    const sum = Object.values(partial.perSourceBudget).reduce((a, b) => a + b, 0);
    expect(sum).toBe(base.availableBudget);
  });

  it("gives the entire budget to a single connected source", () => {
    const single = reallocateBudget(base, ["gmail"]);
    expect(single.perSourceBudget.gmail).toBe(base.availableBudget);
    expect(single.perSourceBudget.memory).toBe(0);
    expect(single.perSourceBudget.github).toBe(0);
  });

  it("zeroes every allocation when no source is connected", () => {
    const none = reallocateBudget(base, []);
    expect(Object.values(none.perSourceBudget).every((value) => value === 0)).toBe(true);
  });

  it("zeroes every allocation when only unknown sources are connected", () => {
    const unknown = reallocateBudget(base, ["not-a-source"]);
    expect(Object.values(unknown.perSourceBudget).every((value) => value === 0)).toBe(true);
  });

  it("preserves total, reserved, and available budgets", () => {
    const partial = reallocateBudget(base, ["memory"]);
    expect(partial.totalBudget).toBe(base.totalBudget);
    expect(partial.reservedBudget).toBe(base.reservedBudget);
    expect(partial.availableBudget).toBe(base.availableBudget);
  });

  it("does not mutate the input budget", () => {
    const before = { ...base, perSourceBudget: { ...base.perSourceBudget } };
    reallocateBudget(base, ["memory", "gmail"]);
    expect(base).toEqual(before);
  });

  it("returns a new object without shared references", () => {
    const result = reallocateBudget(base, ["gmail"]);
    expect(result).not.toBe(base);
    expect(result.perSourceBudget).not.toBe(base.perSourceBudget);
  });
});

describe("trimToBudget", () => {
  it("keeps the whole array when it fits exactly", () => {
    const items = [{ tokenEstimate: 3 }, { tokenEstimate: 2 }, { tokenEstimate: 5 }];
    expect(trimToBudget(items, 10)).toEqual(items);
  });

  it("keeps the whole array when the budget exceeds the total", () => {
    const items = [{ tokenEstimate: 1 }, { tokenEstimate: 2 }];
    expect(trimToBudget(items, 100)).toEqual(items);
  });

  it("cuts the prefix at the point of overflow", () => {
    expect(trimToBudget([{ tokenEstimate: 3 }, { tokenEstimate: 2 }, { tokenEstimate: 5 }], 5)).toEqual([
      { tokenEstimate: 3 },
      { tokenEstimate: 2 },
    ]);
    expect(trimToBudget([{ tokenEstimate: 3 }, { tokenEstimate: 2 }, { tokenEstimate: 5 }], 4)).toEqual([
      { tokenEstimate: 3 },
    ]);
  });

  it("returns an empty prefix when the first item exceeds the budget", () => {
    expect(trimToBudget([{ tokenEstimate: 10 }], 5)).toEqual([]);
  });

  it("returns an empty array for an empty input", () => {
    expect(trimToBudget([], 100)).toEqual([]);
  });

  it("returns an empty array for a zero budget", () => {
    expect(trimToBudget([{ tokenEstimate: 1 }, { tokenEstimate: 2 }], 0)).toEqual([]);
  });

  it("returns the same item references (no copies)", () => {
    const item = { tokenEstimate: 4 };
    const result = trimToBudget([item], 10);
    expect(result[0]).toBe(item);
  });
});
