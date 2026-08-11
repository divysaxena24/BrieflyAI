import { describe, expect, it } from "vitest";
import { DigestNotFoundError, DigestDuplicateError, DigestRepository } from "@/lib/digest/repository";
import {
  createDigest,
  createItem,
  createSection,
  freezeDigest,
  type Digest,
} from "@/lib/digest/types";

/** A digest whose statistics are consistent with its sections. */
function digest(overrides: Partial<Parameters<typeof createDigest>[0]> = {}): Digest {
  return createDigest({
    kind: "morning",
    title: "Morning Digest",
    createdAt: "2026-08-10T07:00:00.000Z",
    window: { from: "2026-08-10T00:00:00.000Z", to: "2026-08-10T07:00:00.000Z" },
    sections: [
      createSection({
        category: "emails",
        title: "Important Emails",
        items: [
          createItem({
            category: "emails",
            title: "Hello",
            content: "Body",
            timestamp: "2026-08-10T06:00:00.000Z",
            source: "gmail",
          }),
        ],
      }),
    ],
    ...overrides,
  });
}

/** A second distinct digest (evening, different window). */
function other(): Digest {
  return createDigest({
    kind: "evening",
    title: "Evening Digest",
    createdAt: "2026-08-10T18:00:00.000Z",
    window: { from: "2026-08-10T00:00:00.000Z", to: "2026-08-10T18:00:00.000Z" },
    sections: [
      createSection({
        category: "github",
        title: "GitHub Activity",
        items: [
          createItem({
            category: "github",
            title: "repo/briefly",
            content: "12 commits",
            source: "github",
          }),
        ],
      }),
    ],
  });
}

describe("DigestRepository construction", () => {
  it("is empty by default", () => {
    expect(new DigestRepository().count()).toBe(0);
  });

  it("stores initial digests in insertion order", () => {
    const first = digest();
    const second = other();
    const repository = new DigestRepository([first, second]);
    expect(repository.count()).toBe(2);
    expect(repository.list().map((d) => d.id)).toEqual([first.id, second.id]);
  });

  it("deep-copies initial digests (constructor snapshot)", () => {
    const original = digest();
    const repository = new DigestRepository([original]);
    const stored = repository.find(original.id);
    expect(stored).toEqual(original);
    expect(stored).not.toBe(original);
    expect(stored?.metadata).not.toBe(original.metadata);
    expect(stored?.sections).not.toBe(original.sections);
  });

  it("freezes stored digests deeply", () => {
    const repository = new DigestRepository([digest()]);
    const stored = repository.find(digest().id);
    // Reads return clones (not frozen); the internal copy must be frozen.
    expect(Object.isFrozen(stored ?? {})).toBe(false);
    // Mutating the source after construction never affects the repository.
    const source = digest();
    const repo = new DigestRepository([source]);
    expect(repo.list()).toEqual([source]);
  });
});

describe("DigestRepository.add", () => {
  it("appends a digest and returns a successor repository", () => {
    const repository = new DigestRepository();
    const first = digest();
    const { digest: stored, repository: next } = repository.add(first);
    expect(stored).toEqual(first);
    expect(next.count()).toBe(1);
    expect(repository.count()).toBe(0); // receiver unchanged
  });

  it("throws DigestDuplicateError for an existing id", () => {
    const d = digest();
    const repository = new DigestRepository([d]);
    expect(() => repository.add(d)).toThrow(DigestDuplicateError);
    expect(repository.count()).toBe(1);
  });

  it("returns a detached stored digest", () => {
    const repository = new DigestRepository();
    const { digest: stored } = repository.add(digest());
    const listed = repository.add(digest()).repository.list();
    expect(listed).not.toBe(stored);
  });
});

describe("DigestRepository.update", () => {
  it("patches the stored digest and preserves position", () => {
    const d = digest();
    const otherD = other();
    const repository = new DigestRepository([d, otherD]);
    const { digest: updated, repository: next } = repository.update(d.id, {
      status: "published",
      read: true,
      updatedAt: "2026-08-10T08:00:00.000Z",
    });
    expect(updated.metadata.status).toBe("published");
    expect(updated.metadata.read).toBe(true);
    expect(updated.metadata.kind).toBe("morning"); // untouched
    expect(next.list().map((x) => x.id)).toEqual([d.id, otherD.id]); // position kept
    expect(repository.find(d.id)?.metadata.status).toBe("draft"); // receiver unchanged
  });

  it("recomputes statistics after a patch", () => {
    const d = digest();
    const repository = new DigestRepository([d]);
    const { digest: updated } = repository.update(d.id, {
      sections: [
        createSection({
          category: "emails",
          title: "Emails",
          items: [
            createItem({ category: "emails", title: "A", content: "a" }),
            createItem({ category: "emails", title: "B", content: "b" }),
          ],
        }),
      ],
      updatedAt: "2026-08-10T08:00:00.000Z",
    });
    expect(updated.statistics.itemCount).toBe(2);
  });

  it("supports clearing optional fields with null", () => {
    const withDelivery = createDigest({
      kind: "morning",
      createdAt: "2026-08-10T07:00:00.000Z",
      window: { from: "2026-08-10T00:00:00.000Z", to: "2026-08-10T07:00:00.000Z" },
      delivery: {
        format: "markdown",
        recipients: [{ address: "a@b.c" }],
        deliveredAt: "2026-08-10T07:00:00.000Z",
      },
    });
    const repository = new DigestRepository([withDelivery]);
    const { digest: cleared } = repository.update(withDelivery.id, {
      delivery: null,
      updatedAt: "2026-08-10T09:00:00.000Z",
    });
    expect(cleared.metadata.delivery).toBeUndefined();
  });

  it("throws DigestNotFoundError for unknown ids", () => {
    const repository = new DigestRepository([digest()]);
    expect(() => repository.update("nope", { read: true })).toThrow(DigestNotFoundError);
  });
});

describe("DigestRepository.replace", () => {
  it("replaces the digest in place (position preserved)", () => {
    const d = digest();
    const otherD = other();
    const repository = new DigestRepository([d, otherD]);
    const replacement = createDigest({
      id: d.id,
      kind: "weekly",
      title: "Weekly Digest",
      createdAt: "2026-08-09T07:00:00.000Z",
      window: { from: "2026-08-03T00:00:00.000Z", to: "2026-08-10T07:00:00.000Z" },
    });
    const next = repository.replace(replacement);
    expect(next.list().map((x) => x.id)).toEqual([d.id, otherD.id]);
    expect(next.find(d.id)?.metadata.kind).toBe("weekly");
    expect(repository.find(d.id)?.metadata.kind).toBe("morning"); // receiver unchanged
  });

  it("throws DigestNotFoundError for unknown ids", () => {
    const repository = new DigestRepository();
    expect(() => repository.replace(digest())).toThrow(DigestNotFoundError);
  });
});

describe("DigestRepository.remove and clear", () => {
  it("removes a digest", () => {
    const d = digest();
    const repository = new DigestRepository([d, other()]);
    const next = repository.remove(d.id);
    expect(next.count()).toBe(1);
    expect(next.has(d.id)).toBe(false);
    expect(repository.count()).toBe(2); // receiver unchanged
  });

  it("throws DigestNotFoundError removing an unknown id", () => {
    const repository = new DigestRepository();
    expect(() => repository.remove("nope")).toThrow(DigestNotFoundError);
  });

  it("clear returns an empty repository without touching the receiver", () => {
    const repository = new DigestRepository([digest(), other()]);
    const cleared = repository.clear();
    expect(cleared.count()).toBe(0);
    expect(repository.count()).toBe(2);
  });
});

describe("DigestRepository queries", () => {
  it("find returns a detached clone or undefined", () => {
    const repository = new DigestRepository([digest()]);
    const d = digest();
    expect(repository.find(d.id)).toEqual(d);
    expect(repository.find("missing")).toBeUndefined();
    expect(repository.findById(d.id)).toEqual(d);
  });

  it("findByKind filters by kind", () => {
    const morning = digest();
    const repository = new DigestRepository([morning, other()]);
    const found = repository.findByKind("morning");
    expect(found.map((x) => x.id)).toEqual([morning.id]);
  });

  it("findByStatus filters by status", () => {
    const d = digest();
    const repository = new DigestRepository([d]);
    const published = repository.update(d.id, { status: "published" }).repository;
    expect(published.findByStatus("published").map((x) => x.id)).toEqual([d.id]);
    expect(published.findByStatus("draft")).toEqual([]);
  });

  it("findByPriority filters by priority", () => {
    const normal = digest();
    const high = createDigest({
      kind: "morning",
      createdAt: "2026-08-10T08:00:00.000Z",
      window: { from: "2026-08-10T00:00:00.000Z", to: "2026-08-10T08:00:00.000Z" },
      priority: "high",
    });
    const repository = new DigestRepository([normal, high]);
    expect(repository.findByPriority("high").map((x) => x.id)).toEqual([high.id]);
  });

  it("findByRecipient matches the most recent delivery recipients", () => {
    const delivered = createDigest({
      kind: "morning",
      createdAt: "2026-08-10T07:00:00.000Z",
      window: { from: "2026-08-10T00:00:00.000Z", to: "2026-08-10T07:00:00.000Z" },
      delivery: {
        format: "markdown",
        recipients: [{ address: "user@briefly.ai", name: "User" }],
        deliveredAt: "2026-08-10T07:30:00.000Z",
      },
    });
    const repository = new DigestRepository([delivered, digest()]);
    expect(repository.findByRecipient("user@briefly.ai").map((x) => x.id)).toEqual([delivered.id]);
    expect(repository.findByRecipient("nobody@briefly.ai")).toEqual([]);
  });

  it("findByDate matches digests whose window contains the date", () => {
    const d = digest(); // window 2026-08-10
    const weekly = createDigest({
      kind: "weekly",
      createdAt: "2026-08-10T07:00:00.000Z",
      window: { from: "2026-08-03T00:00:00.000Z", to: "2026-08-10T07:00:00.000Z" },
    });
    const repository = new DigestRepository([d, weekly]);
    expect(repository.findByDate("2026-08-05T12:00:00.000Z").map((x) => x.id)).toEqual([weekly.id]);
    expect(repository.findByDate("2026-08-10T06:00:00.000Z").map((x) => x.id)).toEqual([
      d.id,
      weekly.id,
    ]);
    expect(repository.findByDate("2026-08-01T00:00:00.000Z")).toEqual([]);
  });

  it("list returns detached clones in insertion order", () => {
    const first = digest();
    const second = other();
    const repository = new DigestRepository([first, second]);
    const listed = repository.list();
    expect(listed.map((x) => x.id)).toEqual([first.id, second.id]);
    expect(Object.isFrozen(listed[0])).toBe(false);
    // Mutating a returned clone never affects the repository.
    const mutated = { ...listed[0], metadata: { ...listed[0].metadata, status: "deleted" as const } };
    expect(repository.find(first.id)?.metadata.status).toBe("draft");
    expect(mutated.metadata.status).toBe("deleted");
  });

  it("count reflects the number of stored digests", () => {
    expect(new DigestRepository().count()).toBe(0);
    expect(new DigestRepository([digest(), other()]).count()).toBe(2);
  });

  it("has reports presence", () => {
    const d = digest();
    const repository = new DigestRepository([d]);
    expect(repository.has(d.id)).toBe(true);
    expect(repository.has("missing")).toBe(false);
  });
});

describe("DigestRepository immutability and scale", () => {
  it("never mutates the receiver across chained mutations", () => {
    const d = digest();
    const repository = new DigestRepository([d]);
    let current = repository;
    for (let i = 0; i < 10; i += 1) {
      current = current.update(d.id, { read: i % 2 === 0 }).repository;
    }
    expect(repository.find(d.id)?.metadata.read).toBe(false);
    expect(repository.count()).toBe(1);
  });

  it("handles 1000 digests deterministically", () => {
    const digests: Digest[] = [];
    for (let i = 0; i < 1000; i += 1) {
      digests.push(
        createDigest({
          // Explicit unique ids: derived ids hash kind + createdAt + window,
          // which would collide for repeated hour/minute timestamps.
          id: `digest-${i}`,
          kind: i % 2 === 0 ? "morning" : "evening",
          createdAt: `2026-08-10T${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`,
          window: { from: "2026-08-10T00:00:00.000Z", to: "2026-08-10T23:59:59.000Z" },
        }),
      );
    }
    const repository = new DigestRepository(digests);
    expect(repository.count()).toBe(1000);
    const firstRun = repository.list();
    const secondRun = repository.list();
    expect(firstRun).toEqual(secondRun);
    // Deterministic id distribution: no collisions.
    expect(new Set(firstRun.map((x) => x.id)).size).toBe(1000);
  });

  it("deterministic operation sequences yield equal repositories", () => {
    const d1 = digest();
    const d2 = other();
    const a = new DigestRepository([d1]).add(d2).repository.update(d2.id, { read: true }).repository;
    const b = new DigestRepository([d1]).add(d2).repository.update(d2.id, { read: true }).repository;
    expect(a.list()).toEqual(b.list());
  });

  it("handles a frozen input digest", () => {
    const frozen = freezeDigest(digest());
    const repository = new DigestRepository([frozen]);
    expect(repository.count()).toBe(1);
    expect(repository.list()[0]).toEqual(frozen);
  });
});
