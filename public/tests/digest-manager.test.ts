import { describe, expect, it } from "vitest";
import { DigestManager } from "@/lib/digest/manager";
import { DigestDuplicateError, DigestNotFoundError, DigestRepository } from "@/lib/digest/repository";
import {
  createDigest,
  createItem,
  createSection,
  createDigestDelivery,
  type Digest,
} from "@/lib/digest/types";

const NOW = "2026-08-10T12:00:00.000Z";

function input(overrides: Partial<Parameters<typeof createDigest>[0]> = {}) {
  return {
    kind: "morning" as const,
    title: "Morning Digest",
    createdAt: NOW,
    window: { from: "2026-08-10T00:00:00.000Z", to: NOW },
    sections: [
      createSection({
        category: "emails",
        title: "Important Emails",
        items: [
          createItem({ category: "emails", title: "Subject", content: "Body", source: "gmail" }),
        ],
      }),
    ],
    ...overrides,
  };
}

function digest(id = "digest-x"): Digest {
  return createDigest({ ...input(), id });
}

describe("DigestManager construction", () => {
  it("builds over an empty repository by default", () => {
    const manager = new DigestManager();
    expect(manager.count()).toBe(0);
    expect(manager.repository).toBeInstanceOf(DigestRepository);
  });

  it("exposes the backing repository readonly", () => {
    const repository = new DigestRepository([digest()]);
    const manager = new DigestManager(repository);
    expect(manager.repository.count()).toBe(1);
  });
});

describe("DigestManager.createDigest", () => {
  it("creates, stores, and returns the digest plus successor", () => {
    const manager = new DigestManager();
    const { manager: next, digest: created } = manager.createDigest(input());
    expect(created.metadata.kind).toBe("morning");
    expect(created.metadata.status).toBe("draft");
    expect(created.statistics.itemCount).toBe(1);
    expect(next.count()).toBe(1);
    expect(manager.count()).toBe(0); // receiver unchanged
  });

  it("applies deterministic defaults", () => {
    const { digest: created } = new DigestManager().createDigest(input());
    expect(created.metadata.read).toBe(false);
    expect(created.metadata.priority).toBe("normal");
    expect(created.metadata.tags).toEqual([]);
    expect(created.metadata.updatedAt).toBe(NOW);
  });

  it("throws DigestDuplicateError on duplicate ids", () => {
    const d = digest();
    const manager = new DigestManager(new DigestRepository([d]));
    expect(() => manager.createDigest({ ...input(), id: d.id })).toThrow(DigestDuplicateError);
  });

  it("derives a deterministic id from contents", () => {
    const a = new DigestManager().createDigest(input());
    const b = new DigestManager().createDigest(input());
    expect(a.digest.id).toBe(b.digest.id);
    expect(a.digest.id).toMatch(/^digest-[0-9a-f]{8}$/);
  });
});

describe("DigestManager lifecycle", () => {
  it("publishes a digest", () => {
    const d = digest();
    const manager = new DigestManager(new DigestRepository([d]));
    const { manager: next, digest: published } = manager.publishDigest(d.id, NOW);
    expect(published.metadata.status).toBe("published");
    expect(published.metadata.updatedAt).toBe(NOW);
    expect(next.find(d.id)?.metadata.status).toBe("published");
    expect(manager.find(d.id)?.metadata.status).toBe("draft");
  });

  it("archives and restores a digest", () => {
    const d = digest();
    const manager = new DigestManager(new DigestRepository([d]));
    const archived = manager.archiveDigest(d.id, NOW);
    expect(archived.digest.metadata.status).toBe("archived");
    const restored = archived.manager.restoreDigest(d.id, NOW);
    expect(restored.digest.metadata.status).toBe("draft");
  });

  it("soft-deletes a digest and keeps it stored", () => {
    const d = digest();
    const manager = new DigestManager(new DigestRepository([d]));
    const { manager: next, digest: deleted } = manager.deleteDigest(d.id, NOW);
    expect(deleted.metadata.status).toBe("deleted");
    expect(next.has(d.id)).toBe(true); // soft delete — recoverable
    const restored = next.restoreDigest(d.id, NOW);
    expect(restored.digest.metadata.status).toBe("draft");
  });

  it("marks read and unread", () => {
    const d = digest();
    const manager = new DigestManager(new DigestRepository([d]));
    const read = manager.markRead(d.id, NOW);
    expect(read.digest.metadata.read).toBe(true);
    const unread = read.manager.markUnread(d.id, NOW);
    expect(unread.digest.metadata.read).toBe(false);
  });

  it("records a delivery via markDelivered", () => {
    const d = digest();
    const manager = new DigestManager(new DigestRepository([d]));
    const delivery = createDigestDelivery({
      format: "markdown",
      recipients: [{ address: "user@briefly.ai" }],
    });
    const { manager: next, digest: delivered } = manager.markDelivered(d.id, delivery, NOW);
    expect(delivered.metadata.delivery?.format).toBe("markdown");
    expect(delivered.metadata.delivery?.deliveredAt).toBe(NOW);
    expect(delivered.metadata.updatedAt).toBe(NOW);
    expect(next.find(d.id)?.metadata.delivery?.recipients[0].address).toBe("user@briefly.ai");
  });

  it("markDelivered keeps an explicit deliveredAt from the delivery", () => {
    const d = digest();
    const manager = new DigestManager(new DigestRepository([d]));
    const { digest: delivered } = manager.markDelivered(
      d.id,
      createDigestDelivery({
        format: "json",
        recipients: [],
        deliveredAt: "2026-08-10T07:00:00.000Z",
      }),
      NOW,
    );
    expect(delivered.metadata.delivery?.deliveredAt).toBe("2026-08-10T07:00:00.000Z");
  });

  it("throws DigestNotFoundError for unknown ids on every mutation", () => {
    const manager = new DigestManager();
    expect(() => manager.publishDigest("nope", NOW)).toThrow(DigestNotFoundError);
    expect(() => manager.archiveDigest("nope", NOW)).toThrow(DigestNotFoundError);
    expect(() => manager.restoreDigest("nope", NOW)).toThrow(DigestNotFoundError);
    expect(() => manager.deleteDigest("nope", NOW)).toThrow(DigestNotFoundError);
    expect(() => manager.markRead("nope", NOW)).toThrow(DigestNotFoundError);
    expect(() => manager.markUnread("nope", NOW)).toThrow(DigestNotFoundError);
    expect(() =>
      manager.markDelivered("nope", createDigestDelivery({ format: "json", recipients: [] }), NOW),
    ).toThrow(DigestNotFoundError);
  });
});

describe("DigestManager bulk operations", () => {
  it("bulkCreate stores every digest atomically", () => {
    const manager = new DigestManager();
    const { manager: next, digests } = manager.bulkCreate([input(), input({ kind: "evening" })]);
    expect(digests).toHaveLength(2);
    expect(next.count()).toBe(2);
    expect(manager.count()).toBe(0);
  });

  it("bulkCreate throws on the first duplicate without changing the receiver", () => {
    const d = digest();
    const manager = new DigestManager(new DigestRepository([d]));
    expect(() => manager.bulkCreate([input({ id: d.id }), input({ kind: "evening" })])).toThrow(
      DigestDuplicateError,
    );
    expect(manager.count()).toBe(1);
  });

  it("bulkDelete soft-deletes many digests", () => {
    const first = digest("digest-1");
    const second = digest("digest-2");
    const manager = new DigestManager(new DigestRepository([first, second]));
    const next = manager.bulkDelete([first.id, second.id], NOW);
    expect(next.find(first.id)?.metadata.status).toBe("deleted");
    expect(next.find(second.id)?.metadata.status).toBe("deleted");
    expect(manager.find(first.id)?.metadata.status).toBe("draft");
  });

  it("bulkDelete throws on the first unknown id", () => {
    const first = digest("digest-1");
    const manager = new DigestManager(new DigestRepository([first]));
    expect(() => manager.bulkDelete([first.id, "missing"], NOW)).toThrow(DigestNotFoundError);
    expect(manager.find(first.id)?.metadata.status).toBe("draft");
  });
});

describe("DigestManager queries and immutability", () => {
  it("find/list/has/count delegate to the repository", () => {
    const d = digest();
    const manager = new DigestManager(new DigestRepository([d]));
    expect(manager.find(d.id)).toEqual(d);
    expect(manager.find("missing")).toBeUndefined();
    expect(manager.list()).toHaveLength(1);
    expect(manager.has(d.id)).toBe(true);
    expect(manager.count()).toBe(1);
  });

  it("successor chains never mutate earlier managers", () => {
    const d = digest();
    const manager = new DigestManager(new DigestRepository([d]));
    const next = manager.publishDigest(d.id, NOW).manager;
    next.markRead(d.id, NOW);
    expect(manager.find(d.id)?.metadata.status).toBe("draft");
    expect(manager.find(d.id)?.metadata.read).toBe(false);
  });

  it("deterministic for identical operation sequences", () => {
    const d1 = digest();
    const d2 = digest();
    const a = new DigestManager(new DigestRepository([d1])).publishDigest(d1.id, NOW).manager;
    const b = new DigestManager(new DigestRepository([d2])).publishDigest(d2.id, NOW).manager;
    expect(a.list()).toEqual(b.list());
  });

  it("handles 1000 digests through the manager", () => {
    const inputs = Array.from({ length: 1000 }, (_, i) =>
      input({ id: `digest-${i}`, createdAt: `2026-08-10T${String(i % 24).padStart(2, "0")}:00:00.000Z` }),
    );
    const { manager, digests } = new DigestManager().bulkCreate(inputs);
    expect(digests).toHaveLength(1000);
    expect(manager.count()).toBe(1000);
    expect(new Set(manager.list().map((x) => x.id)).size).toBe(1000);
  });
});
