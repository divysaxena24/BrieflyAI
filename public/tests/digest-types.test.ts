import { describe, it, expect } from "vitest";
import {
  createDigest,
  cloneDigest,
  freezeDigest,
  createSection,
  createItem,
  touchDigest,
  estimateDigestTokens,
  computeDigestStatistics,
  hashDigest,
  createDigestSummary,
  createDigestReference,
  createDigestHistory,
  createDigestDelivery,
  createDigestTemplate,
  DEFAULT_DIGEST_STATUS,
  DEFAULT_DIGEST_PRIORITY,
  DEFAULT_DIGEST_READ,
  type CreateDigestInput,
  type Digest,
} from "@/lib/digest/types";

// ──────────────────────────────────────────────
//  Fixtures
// ──────────────────────────────────────────────

const NOW = "2026-08-10T10:00:00.000Z";

function makeItem(id: string, overrides: Partial<Parameters<typeof createItem>[0]> = {}) {
  return createItem({
    id,
    category: "emails",
    title: `Item ${id}`,
    content: "Some content",
    ...overrides,
  });
}

function makeSection(overrides: Partial<Parameters<typeof createSection>[0]> = {}) {
  return createSection({
    category: "emails",
    title: "Emails",
    items: [makeItem("e1")],
    ...overrides,
  });
}

function makeDigestInput(overrides: Partial<CreateDigestInput> = {}): CreateDigestInput {
  return {
    kind: "morning",
    createdAt: NOW,
    window: { from: "2026-08-10T00:00:00.000Z", to: NOW },
    sections: [makeSection()],
    ...overrides,
  };
}

function makeDigest(overrides: Partial<CreateDigestInput> = {}): Digest {
  return createDigest(makeDigestInput(overrides));
}

// ──────────────────────────────────────────────
//  createDigest
// ──────────────────────────────────────────────

describe("createDigest", () => {
  it("applies defaults: draft, normal, unread, empty tags", () => {
    const digest = makeDigest({ id: "d1" });
    expect(digest.id).toBe("d1");
    expect(digest.metadata.kind).toBe("morning");
    expect(digest.metadata.status).toBe(DEFAULT_DIGEST_STATUS);
    expect(digest.metadata.priority).toBe(DEFAULT_DIGEST_PRIORITY);
    expect(digest.metadata.read).toBe(DEFAULT_DIGEST_READ);
    expect(digest.metadata.tags).toEqual([]);
    expect(digest.metadata.createdAt).toBe(NOW);
    expect(digest.metadata.updatedAt).toBe(NOW);
    expect(digest.metadata.window).toEqual({ from: "2026-08-10T00:00:00.000Z", to: NOW });
  });

  it("derives a deterministic id from kind + createdAt + window", () => {
    const first = makeDigest();
    const second = makeDigest();
    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^digest-[0-9a-f]{8}$/);
  });

  it("derives different ids when contents differ", () => {
    expect(makeDigest({ kind: "morning" }).id).not.toBe(makeDigest({ kind: "weekly" }).id);
    expect(makeDigest({ createdAt: NOW }).id).not.toBe(
      makeDigest({ createdAt: "2026-08-11T10:00:00.000Z" }).id,
    );
  });

  it("honors an explicit id", () => {
    expect(makeDigest({ id: "explicit" }).id).toBe("explicit");
  });

  it("copies sections and tags instead of referencing them", () => {
    const sections = [makeSection()];
    const tags = ["a"];
    const digest = makeDigest({ id: "d1", sections, tags });
    sections.push(makeSection());
    tags.push("b");
    expect(digest.sections).toHaveLength(1);
    expect(digest.metadata.tags).toEqual(["a"]);
  });

  it("copies the delivery record", () => {
    const delivery = createDigestDelivery({ format: "markdown", recipients: [{ address: "a@x.com" }], deliveredAt: NOW });
    const digest = makeDigest({ id: "d1", delivery });
    delivery.recipients.push({ address: "b@x.com" });
    expect(digest.metadata.delivery?.recipients).toHaveLength(1);
  });

  it("computes deterministic statistics from sections", () => {
    const digest = makeDigest({ id: "d1" });
    expect(digest.statistics.sectionCount).toBe(1);
    expect(digest.statistics.itemCount).toBe(1);
    expect(digest.statistics.categories).toEqual({ emails: 1 });
    expect(digest.statistics.sourceCount).toBe(0);
  });
});

// ──────────────────────────────────────────────
//  createItem / createSection
// ──────────────────────────────────────────────

describe("createItem and createSection", () => {
  it("createItem derives a deterministic id", () => {
    const input = { category: "emails" as const, title: "T", content: "C" };
    const first = createItem(input);
    const second = createItem(input);
    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^item-[0-9a-f]{8}$/);
  });

  it("createItem applies the normal importance default and copies optionals", () => {
    const item = createItem({ category: "files", title: "T", content: "C", timestamp: NOW, source: "drive" });
    expect(item.importance).toBe("normal");
    expect(item.timestamp).toBe(NOW);
    expect(item.source).toBe("drive");
  });

  it("createSection copies items and defaults priority", () => {
    const items = [makeItem("a")];
    const section = createSection({ category: "github", title: "GitHub", items });
    items.push(makeItem("b"));
    expect(section.items).toHaveLength(1);
    expect(section.priority).toBe(DEFAULT_DIGEST_PRIORITY);
    expect(section.id).toBe("section-github");
  });
});

// ──────────────────────────────────────────────
//  touchDigest
// ──────────────────────────────────────────────

describe("touchDigest", () => {
  it("applies a partial patch and preserves the rest", () => {
    const digest = makeDigest({ id: "d1", priority: "high" });
    const next = touchDigest(digest, { status: "published", read: true, updatedAt: NOW });
    expect(next.metadata.status).toBe("published");
    expect(next.metadata.read).toBe(true);
    expect(next.metadata.priority).toBe("high");
    expect(next.metadata.kind).toBe("morning");
    expect(next.id).toBe("d1");
    expect(digest.metadata.status).toBe("draft");
  });

  it("clears optional fields with null", () => {
    const digest = makeDigest({ id: "d1", title: "Morning", delivery: createDigestDelivery({ format: "json" }) });
    const next = touchDigest(digest, { title: null, delivery: null });
    expect(next.metadata.title).toBeUndefined();
    expect(next.metadata.delivery).toBeUndefined();
  });

  it("recomputes statistics after a patch", () => {
    const digest = makeDigest({ id: "d1" });
    const next = touchDigest(digest, {
      sections: [makeSection(), makeSection({ category: "github", title: "GitHub", items: [makeItem("g1", { category: "github", source: "github" })] })],
    });
    expect(next.statistics.sectionCount).toBe(2);
    expect(next.statistics.itemCount).toBe(2);
    expect(next.statistics.categories).toEqual({ emails: 1, github: 1 });
  });

  it("never mutates the input", () => {
    const digest = makeDigest({ id: "d1" });
    touchDigest(digest, { status: "published" });
    expect(digest.metadata.status).toBe("draft");
  });
});

// ──────────────────────────────────────────────
//  cloneDigest / freezeDigest
// ──────────────────────────────────────────────

describe("cloneDigest and freezeDigest", () => {
  it("cloneDigest returns a deep detached copy with statistics preserved", () => {
    const digest = makeDigest({ id: "d1", tags: ["t"], delivery: createDigestDelivery({ format: "markdown", recipients: [{ address: "a@x.com" }] }) });
    const clone = cloneDigest(digest);
    expect(clone).toEqual(digest);
    expect(clone).not.toBe(digest);
    expect(clone.metadata).not.toBe(digest.metadata);
    expect(clone.metadata.tags).not.toBe(digest.metadata.tags);
    expect(clone.sections).not.toBe(digest.sections);
    expect(clone.sections[0]).not.toBe(digest.sections[0]);
    expect(clone.sections[0].items).not.toBe(digest.sections[0].items);
    expect(clone.sections[0].items[0]).not.toBe(digest.sections[0].items[0]);
    expect(clone.statistics).toEqual(digest.statistics);
  });

  it("mutating the clone never affects the source", () => {
    const digest = makeDigest({ id: "d1", tags: ["t"] });
    const clone = cloneDigest(digest);
    clone.metadata.tags.push("extra");
    clone.sections.push(makeSection({ category: "files", title: "Files" }));
    expect(digest.metadata.tags).toEqual(["t"]);
    expect(digest.sections).toHaveLength(1);
  });

  it("freezeDigest deep-freezes the digest", () => {
    const digest = makeDigest({
      id: "d1",
      tags: ["t"],
      delivery: createDigestDelivery({ format: "plain", recipients: [{ address: "a@x.com" }] }),
    });
    const frozen = freezeDigest(digest);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.metadata)).toBe(true);
    expect(Object.isFrozen(frozen.metadata.tags)).toBe(true);
    expect(Object.isFrozen(frozen.metadata.window)).toBe(true);
    expect(Object.isFrozen(frozen.metadata.delivery)).toBe(true);
    expect(Object.isFrozen(frozen.sections)).toBe(true);
    expect(Object.isFrozen(frozen.sections[0])).toBe(true);
    expect(Object.isFrozen(frozen.sections[0].items)).toBe(true);
    expect(Object.isFrozen(frozen.sections[0].items[0])).toBe(true);
  });

  it("freezeDigest is idempotent", () => {
    const digest = freezeDigest(makeDigest({ id: "d1" }));
    expect(freezeDigest(digest)).toBe(digest);
  });
});

// ──────────────────────────────────────────────
//  estimateDigestTokens / statistics
// ──────────────────────────────────────────────

describe("estimateDigestTokens and computeDigestStatistics", () => {
  it("estimates tokens from section titles and item titles/content", () => {
    const digest = makeDigest({
      id: "d1",
      sections: [
        createSection({ category: "emails", title: "Emails", items: [makeItem("e1", { title: "Subject", content: "Body text here" })] }),
      ],
    });
    const expected =
      Math.ceil("Emails".length / 4) + Math.ceil("Subject".length / 4) + Math.ceil("Body text here".length / 4);
    expect(estimateDigestTokens(digest)).toBe(expected);
  });

  it("counts sources and excludes the statistics section from categories", () => {
    const digest = makeDigest({
      id: "d1",
      sections: [
        createSection({ category: "emails", title: "Emails", items: [makeItem("e1", { source: "gmail" }), makeItem("e2", { source: "gmail" })] }),
        createSection({ category: "github", title: "GitHub", items: [makeItem("g1", { category: "github", source: "github" })] }),
        createSection({ category: "statistics", title: "Statistics", items: [makeItem("s1", { category: "statistics", source: "statistics" })] }),
      ],
    });
    const stats = computeDigestStatistics(digest);
    expect(stats.sectionCount).toBe(3);
    expect(stats.itemCount).toBe(3);
    expect(stats.sourceCount).toBe(2);
    expect(stats.categories).toEqual({ emails: 2, github: 1 });
  });
});

// ──────────────────────────────────────────────
//  Projections and references
// ──────────────────────────────────────────────

describe("projections, references, history", () => {
  it("createDigestSummary projects the core fields", () => {
    const digest = makeDigest({ id: "d1", priority: "high" });
    const summary = createDigestSummary(digest);
    expect(summary.id).toBe("d1");
    expect(summary.kind).toBe("morning");
    expect(summary.status).toBe("draft");
    expect(summary.priority).toBe("high");
    expect(summary.read).toBe(false);
    expect(summary.createdAt).toBe(NOW);
    expect(summary.sectionCount).toBe(1);
    expect(summary.itemCount).toBe(1);
  });

  it("createDigestReference carries id and kind", () => {
    expect(createDigestReference(makeDigest({ id: "d1", kind: "weekly" }))).toEqual({
      digestId: "d1",
      kind: "weekly",
    });
  });

  it("createDigestHistory reflects publication, read, and deliveries", () => {
    let digest = makeDigest({ id: "d1" });
    digest = touchDigest(digest, { status: "published", read: true, delivery: createDigestDelivery({ format: "json", deliveredAt: NOW }) });
    const history = createDigestHistory(digest);
    expect(history.publishedAt).toBe(NOW);
    expect(history.readAt).toBe(NOW);
    expect(history.deliveries).toHaveLength(1);
    expect(history.deliveries[0].format).toBe("json");
  });

  it("createDigestDelivery copies recipients", () => {
    const recipients = [{ address: "a@x.com" }];
    const delivery = createDigestDelivery({ format: "plain", recipients, deliveredAt: NOW });
    recipients.push({ address: "b@x.com" });
    expect(delivery.recipients).toHaveLength(1);
    expect(delivery.deliveredAt).toBe(NOW);
  });
});

// ──────────────────────────────────────────────
//  Templates
// ──────────────────────────────────────────────

describe("createDigestTemplate", () => {
  it("builds a template with defaults and copies sections", () => {
    const sections = [{ category: "emails" as const, title: "Emails", priority: "high" as const, maxItems: 5 }];
    const template = createDigestTemplate({ id: "t1", kind: "morning", title: "Morning", sections });
    sections.push({ category: "files" as const, title: "Files", priority: "normal" as const });
    expect(template.sections).toHaveLength(1);
    expect(template.priority).toBe(DEFAULT_DIGEST_PRIORITY);
    expect(template.windowDays).toBe(1);
  });

  it("defaults windowDays to 7 for weekly templates", () => {
    const template = createDigestTemplate({ id: "tw", kind: "weekly", title: "Weekly", sections: [] });
    expect(template.windowDays).toBe(7);
  });

  it("rejects duplicate section categories", () => {
    expect(() =>
      createDigestTemplate({
        id: "t1",
        kind: "morning",
        title: "Morning",
        sections: [
          { category: "emails", title: "Emails", priority: "normal" },
          { category: "emails", title: "Emails 2", priority: "normal" },
        ],
      }),
    ).toThrow(/duplicate section category/);
  });
});

// ──────────────────────────────────────────────
//  Determinism
// ──────────────────────────────────────────────

describe("determinism", () => {
  it("hashDigest is deterministic and distinguishes inputs", () => {
    expect(hashDigest("a")).toBe(hashDigest("a"));
    expect(hashDigest("a")).not.toBe(hashDigest("b"));
  });

  it("identical inputs produce deep-equal digests", () => {
    expect(makeDigest({ id: "d1" })).toEqual(makeDigest({ id: "d1" }));
  });
});
