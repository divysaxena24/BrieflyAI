/**
 * Phase 5J STEP 2/3 — in-memory persistence store tests.
 */
import { describe, expect, it } from "vitest";
import { MemoryPersistenceStore } from "@/lib/persistence/store";
import { createStoredCollection, type CollectionKind } from "@/lib/persistence/types";

function collection(scope: string, kind: CollectionKind, payload = "[]") {
  return createStoredCollection({ scope, kind, version: 1, payload });
}

describe("MemoryPersistenceStore", () => {
  it("reads undefined for never-written collections", async () => {
    const store = new MemoryPersistenceStore();
    expect(await store.read("app", "memory")).toBeUndefined();
    expect(store.count()).toBe(0);
  });

  it("writes and reads back a collection (detached clone)", async () => {
    const store = new MemoryPersistenceStore();
    const stored = collection("user-1", "memory", '[{"id":"m"}]');
    await store.write("user-1", "memory", stored);
    const read = await store.read("user-1", "memory");
    expect(read).toEqual(stored);
    expect(read).not.toBe(stored);
    expect(store.count()).toBe(1);
    // Mutating the read clone never affects the store.
    if (read) (read as { payload: string }).payload = "mutated";
    expect((await store.read("user-1", "memory"))?.payload).toBe('[{"id":"m"}]');
  });

  it("namespaces collections by scope and kind", async () => {
    const store = new MemoryPersistenceStore();
    await store.write("user-1", "memory", collection("user-1", "memory", "[1]"));
    await store.write("user-2", "memory", collection("user-2", "memory", "[2]"));
    await store.write("user-1", "job", collection("user-1", "job", "[3]"));
    expect((await store.read("user-1", "memory"))?.payload).toBe("[1]");
    expect((await store.read("user-2", "memory"))?.payload).toBe("[2]");
    expect((await store.read("user-1", "job"))?.payload).toBe("[3]");
    expect(store.count()).toBe(3);
  });

  it("replaces wholesale on repeated writes", async () => {
    const store = new MemoryPersistenceStore();
    await store.write("app", "digest", collection("app", "digest", "[1]"));
    await store.write("app", "digest", collection("app", "digest", "[1,2]"));
    expect((await store.read("app", "digest"))?.payload).toBe("[1,2]");
    expect(store.count()).toBe(1);
  });

  it("clears a collection (never throws when absent)", async () => {
    const store = new MemoryPersistenceStore();
    await store.write("app", "action", collection("app", "action", "[]"));
    await store.clear("app", "action");
    expect(await store.read("app", "action")).toBeUndefined();
    expect(store.count()).toBe(0);
    await store.clear("app", "action"); // idempotent
    expect(store.count()).toBe(0);
  });

  it("derives stable collection ids from scope + kind", () => {
    const a = collection("user-1", "memory");
    const b = collection("user-1", "memory");
    const c = collection("user-1", "job");
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
    expect(a.id).toMatch(/^collection-[0-9a-f]{8}$/);
  });

  it("seeds from an initial snapshot", async () => {
    const initial = collection("app", "workflow", "[{}]");
    const store = new MemoryPersistenceStore([initial]);
    expect(await store.read("app", "workflow")).toEqual(initial);
    expect(store.count()).toBe(1);
  });

  it("lists detached clones in insertion order", async () => {
    const store = new MemoryPersistenceStore();
    await store.write("app", "memory", collection("app", "memory"));
    await store.write("app", "job", collection("app", "job"));
    expect(store.list().map((c) => c.kind)).toEqual(["memory", "job"]);
    (store.list()[0] as { payload: string }).payload = "mutated";
    expect(store.list()[0]!.payload).toBe("[]");
  });

  it("has() reports presence", async () => {
    const store = new MemoryPersistenceStore();
    expect(store.has("app", "memory")).toBe(false);
    await store.write("app", "memory", collection("app", "memory"));
    expect(store.has("app", "memory")).toBe(true);
  });

  it("clearAll returns a fresh empty store without touching the receiver", () => {
    const store = new MemoryPersistenceStore();
    void store.write("app", "memory", collection("app", "memory"));
    const cleared = store.clearAll();
    expect(cleared.count()).toBe(0);
    expect(store.count()).toBe(1);
  });
});
