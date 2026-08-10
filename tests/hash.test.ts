/**
 * Phase 5J STEP 1 — shared hash helper tests.
 */
import { describe, expect, it } from "vitest";
import { FNV_OFFSET_BASIS, FNV_PRIME, hashString } from "@/lib/hash";

describe("hashString", () => {
  it("is deterministic for identical inputs", () => {
    expect(hashString("hello")).toBe(hashString("hello"));
    expect(hashString("job-123")).toBe(hashString("job-123"));
    expect(hashString("")).toBe(hashString(""));
  });

  it("is a stable 8-character lowercase hex string", () => {
    for (const value of ["", "a", "hello world", "digest-2026-08-10", "x".repeat(1000)]) {
      const hash = hashString(value);
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    }
  }, 10000);

  it("matches the canonical FNV-1a vectors", () => {
    // Canonical FNV-1a 32-bit test vectors.
    expect(hashString("")).toBe("811c9dc5");
    expect(hashString("a")).toBe("e40c292c");
    expect(hashString("foobar")).toBe("bf9cf968");
  });

  it("differs for different inputs (no trivial collisions)", () => {
    expect(hashString("a")).not.toBe(hashString("b"));
    expect(hashString("job")).not.toBe(hashString("jobx"));
    expect(hashString("memory:1")).not.toBe(hashString("memory:2"));
  });

  it("is stable across the engine layers' inputs", () => {
    // The engine id derivations hash "name:trigger:priority:createdAt:scheduledAt".
    const input = "Background Daily Digest:recurring:normal:2026-08-10T08:00:00.000Z:2026-08-10T08:00:00.000Z";
    expect(hashString(input)).toBe(hashString(input));
    expect(hashString(input)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("exposes the FNV-1a constants", () => {
    expect(FNV_OFFSET_BASIS).toBe(0x811c9dc5);
    expect(FNV_PRIME).toBe(0x01000193);
  });

  it("handles unicode input deterministically (charCodeAt semantics)", () => {
    const a = hashString("café");
    const b = hashString("café");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
});
