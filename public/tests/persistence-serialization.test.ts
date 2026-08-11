/**
 * Phase 5J STEP 2/3 — collection serialization tests.
 */
import { describe, expect, it } from "vitest";
import {
  createCollectionCodec,
  deserializeCollection,
  serializeCollection,
} from "@/lib/persistence/serialization";
import { PersistenceCorruptError, PersistenceVersionError } from "@/lib/persistence/types";

interface SampleRecord {
  readonly id: string;
  readonly name: string;
  readonly values?: readonly number[];
}

const codec = createCollectionCodec<SampleRecord>("memory");

describe("createCollectionCodec / serializeCollection", () => {
  it("serializes records to deterministic JSON", () => {
    const records: readonly SampleRecord[] = [
      { id: "a", name: "one", values: [1, 2] },
      { id: "b", name: "two" },
    ];
    const first = serializeCollection(records, codec);
    const second = serializeCollection([...records], codec);
    expect(first).toBe(second);
    expect(JSON.parse(first)).toEqual(records);
  });

  it("serializes an empty collection", () => {
    expect(serializeCollection([], codec)).toBe("[]");
  });

  it("carries the collection kind and default version", () => {
    expect(codec.kind).toBe("memory");
    expect(codec.version).toBe(1);
  });

  it("supports custom schema versions", () => {
    const v2 = createCollectionCodec<SampleRecord>("job", 2);
    expect(v2.version).toBe(2);
  });
});

describe("deserializeCollection", () => {
  it("round-trips a payload back to detached records", () => {
    const records: readonly SampleRecord[] = [
      { id: "a", name: "one", values: [1, 2] },
      { id: "b", name: "two" },
    ];
    const payload = serializeCollection(records, codec);
    const restored = deserializeCollection({ scope: "s", kind: "memory", version: 1, payload }, codec);
    expect(restored).toEqual(records);
    // Detached: mutating the result never affects future reads.
    (restored as SampleRecord[]).push({ id: "c", name: "three" });
    expect(deserializeCollection({ scope: "s", kind: "memory", version: 1, payload }, codec)).toHaveLength(2);
  });

  it("rejects non-array payloads structurally", () => {
    expect(() =>
      deserializeCollection({ scope: "s", kind: "memory", version: 1, payload: '{"id":"x"}' }, codec),
    ).toThrow(PersistenceCorruptError);
    expect(() =>
      deserializeCollection({ scope: "s", kind: "memory", version: 1, payload: '"nope"' }, codec),
    ).toThrow(PersistenceCorruptError);
  });

  it("rejects invalid JSON structurally", () => {
    expect(() =>
      deserializeCollection({ scope: "s", kind: "memory", version: 1, payload: "{not json" }, codec),
    ).toThrow(PersistenceCorruptError);
  });

  it("rejects records without a string id", () => {
    expect(() =>
      deserializeCollection({ scope: "s", kind: "memory", version: 1, payload: '[{"id":1}]' }, codec),
    ).toThrow(PersistenceCorruptError);
    expect(() =>
      deserializeCollection({ scope: "s", kind: "memory", version: 1, payload: "[null]" }, codec),
    ).toThrow(PersistenceCorruptError);
  });

  it("rejects payloads written by a newer schema version", () => {
    const newer = createCollectionCodec<SampleRecord>("memory", 2);
    const payload = serializeCollection([{ id: "a", name: "one" }], newer);
    expect(() =>
      deserializeCollection({ scope: "s", kind: "memory", version: 2, payload }, codec),
    ).toThrow(PersistenceVersionError);
  });

  it("accepts payloads written by an older schema version", () => {
    const older = createCollectionCodec<SampleRecord>("memory", 1);
    const payload = serializeCollection([{ id: "a", name: "one" }], older);
    const v3 = createCollectionCodec<SampleRecord>("memory", 3);
    expect(deserializeCollection({ scope: "s", kind: "memory", version: 1, payload }, v3)).toHaveLength(1);
  });
});
