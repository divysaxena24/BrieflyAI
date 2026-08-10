import { describe, expect, it } from "vitest";
import {
  DigestDeliveryEngine,
  DigestFormatter,
  NoopPublisher,
  formatDigest,
  formatDigestAsJson,
  formatDigestAsMarkdown,
  formatDigestAsPlain,
  formatDigestAsObject,
  DEFAULT_DELIVERY_FORMAT,
  type DigestPublisher,
  type DeliveryResult,
} from "@/lib/digest/delivery";
import { DigestManager } from "@/lib/digest/manager";
import { createDigest, createItem, createSection, type Digest } from "@/lib/digest/types";

const NOW = "2026-08-10T12:00:00.000Z";

/** A digest with three sections (one empty) and multi-line items. */
function sampleDigest(): Digest {
  return createDigest({
    kind: "morning",
    title: "Morning Digest",
    createdAt: NOW,
    window: { from: "2026-08-10T00:00:00.000Z", to: NOW },
    sections: [
      createSection({
        category: "emails",
        title: "Important Emails",
        items: [
          createItem({
            category: "emails",
            title: "Hello\nWorld",
            content: "Line one\nLine two",
            importance: "high",
            source: "gmail",
          }),
        ],
      }),
      createSection({
        category: "actions",
        title: "Pending Actions",
        priority: "high",
        items: [
          createItem({
            category: "actions",
            title: "Review PR",
            content: "",
            source: "job",
          }),
        ],
      }),
      createSection({
        category: "statistics",
        title: "Statistics",
        priority: "low",
        items: [],
      }),
    ],
  });
}

function managerWithDigest(digest: Digest = sampleDigest()): DigestManager {
  return new DigestManager()
    .createDigest({
      kind: digest.metadata.kind,
      title: digest.metadata.title,
      createdAt: digest.metadata.createdAt,
      priority: digest.metadata.priority,
      window: digest.metadata.window,
      sections: digest.sections,
    })
    .manager;
}

describe("formatDigestAsJson", () => {
  it("pretty-prints the digest deterministically", () => {
    const a = formatDigestAsJson(sampleDigest());
    const b = formatDigestAsJson(sampleDigest());
    expect(a).toBe(b);
    expect(a).toContain('"kind": "morning"');
    expect(JSON.parse(a).id).toBe(sampleDigest().id);
  });
});

describe("formatDigestAsMarkdown", () => {
  it("renders a level-1 heading per digest and level-2 headings per section", () => {
    const md = formatDigestAsMarkdown(sampleDigest());
    expect(md).toContain("# Morning Digest");
    expect(md).toContain("## Important Emails");
    expect(md).toContain("## Pending Actions");
  });

  it("renders items as bullets with importance markers", () => {
    const md = formatDigestAsMarkdown(sampleDigest());
    expect(md).toContain("- **Hello World** (high) — Line one Line two");
    expect(md).toContain("- **Review PR**");
  });

  it("collapses newlines inside item titles and content", () => {
    const md = formatDigestAsMarkdown(sampleDigest());
    expect(md).not.toContain("Hello\nWorld");
    expect(md).toContain("Hello World");
  });

  it("renders _No items._ for empty sections", () => {
    const md = formatDigestAsMarkdown(sampleDigest());
    expect(md).toContain("_No items._");
  });

  it("omits importance for normal items", () => {
    const digest = createDigest({
      kind: "morning",
      createdAt: NOW,
      window: { from: NOW, to: NOW },
      sections: [
        createSection({
          category: "emails",
          title: "Emails",
          items: [createItem({ category: "emails", title: "T", content: "C" })],
        }),
      ],
    });
    const md = formatDigestAsMarkdown(digest);
    expect(md).toContain("- **T** — C");
    expect(md).not.toContain("(normal)");
  });
});

describe("formatDigestAsPlain", () => {
  it("renders an uppercase title banner and section labels", () => {
    const plain = formatDigestAsPlain(sampleDigest());
    expect(plain).toContain("MORNING DIGEST");
    expect(plain).toContain("IMPORTANT EMAILS");
    expect(plain).toContain("PENDING ACTIONS");
  });

  it("renders items as indented bullets", () => {
    const plain = formatDigestAsPlain(sampleDigest());
    expect(plain).toContain("  • Hello World — Line one Line two");
  });

  it("renders (no items) for empty sections", () => {
    const plain = formatDigestAsPlain(sampleDigest());
    expect(plain).toContain("  (no items)");
  });
});

describe("formatDigestAsObject", () => {
  it("returns a detached clone", () => {
    const digest = sampleDigest();
    const clone = formatDigestAsObject(digest);
    expect(clone).toEqual(digest);
    expect(clone).not.toBe(digest);
    expect(clone.sections).not.toBe(digest.sections);
  });
});

describe("formatDigest", () => {
  it("dispatches by format", () => {
    const digest = sampleDigest();
    expect(typeof formatDigest(digest, "json")).toBe("string");
    expect(typeof formatDigest(digest, "markdown")).toBe("string");
    expect(typeof formatDigest(digest, "plain")).toBe("string");
    expect(formatDigest(digest, "object")).toEqual(digest);
  });

  it("is deterministic across formats", () => {
    const digest = sampleDigest();
    for (const format of ["json", "markdown", "plain", "object"] as const) {
      expect(formatDigest(digest, format)).toEqual(formatDigest(digest, format));
    }
  });
});

describe("DigestFormatter", () => {
  it("exposes the format surface", () => {
    const formatter = new DigestFormatter();
    const digest = sampleDigest();
    expect(typeof formatter.asJson(digest)).toBe("string");
    expect(formatter.asMarkdown(digest)).toContain("# Morning Digest");
    expect(formatter.asPlain(digest)).toContain("MORNING DIGEST");
    expect(formatter.asObject(digest)).toEqual(digest);
    expect(formatter.format(digest, "json")).toBe(formatter.asJson(digest));
  });
});

describe("DigestDeliveryEngine", () => {
  it("defaults the format to markdown", () => {
    expect(DEFAULT_DELIVERY_FORMAT).toBe("markdown");
  });

  it("formats without delivering", () => {
    const engine = new DigestDeliveryEngine(managerWithDigest(), { now: () => NOW });
    const formatted = engine.format(sampleDigest(), "markdown");
    expect(formatted).toContain("# Morning Digest");
  });

  it("delivers through the injected publisher and records the delivery", async () => {
    const published: Array<{ format: string; content: unknown; recipients: unknown }> = [];
    const publisher: DigestPublisher = {
      publish: async (delivery, content) => {
        published.push({ format: delivery.format, content, recipients: delivery.recipients });
      },
    };
    const manager = managerWithDigest();
    const engine = new DigestDeliveryEngine(manager, { publisher, now: () => NOW });
    const digest = sampleDigest();
    const { manager: next, result } = await engine.deliver(digest, {
      recipients: [{ address: "user@briefly.ai", name: "User" }],
    });
    expect(published).toHaveLength(1);
    expect(published[0].format).toBe("markdown");
    expect(published[0].content).toContain("# Morning Digest");
    expect((published[0].recipients as { address: string }[])[0].address).toBe("user@briefly.ai");
    expect(result.format).toBe("markdown");
    expect(result.digestId).toBe(digest.id);
    expect(result.deliveredAt).toBe(NOW);
    // Delivery recorded on the successor manager only.
    expect(next.find(digest.id)?.metadata.delivery?.format).toBe("markdown");
    expect(manager.find(digest.id)?.metadata.delivery).toBeUndefined();
  });

  it("honors a per-delivery format and explicit at", async () => {
    const engine = new DigestDeliveryEngine(managerWithDigest(), { now: () => NOW });
    const digest = sampleDigest();
    const { manager: next, result } = await engine.deliver(digest, {
      format: "plain",
      recipients: [],
      at: "2026-08-10T08:00:00.000Z",
    });
    expect(result.format).toBe("plain");
    expect(result.content).toContain("MORNING DIGEST");
    expect(result.deliveredAt).toBe("2026-08-10T08:00:00.000Z");
    expect(next.find(digest.id)?.metadata.delivery?.deliveredAt).toBe("2026-08-10T08:00:00.000Z");
  });

  it("supports a per-delivery publisher override", async () => {
    const fallback: DigestPublisher = {
      publish: async () => {
        throw new Error("fallback publisher should not run");
      },
    };
    const override: DigestPublisher = {
      publish: async () => undefined,
    };
    const engine = new DigestDeliveryEngine(managerWithDigest(), {
      publisher: fallback,
      now: () => NOW,
    });
    const { result } = await engine.deliver(sampleDigest(), {
      recipients: [],
      publisher: override,
    });
    expect(result.digestId).toBe(sampleDigest().id);
  });

  it("uses the injected clock for deliveredAt when at is omitted", async () => {
    const engine = new DigestDeliveryEngine(managerWithDigest(), { now: () => NOW });
    const { result } = await engine.deliver(sampleDigest(), { recipients: [] });
    expect(result.deliveredAt).toBe(NOW);
  });

  it("defaults to the wall clock when no now is injected", async () => {
    const engine = new DigestDeliveryEngine(managerWithDigest());
    const { result } = await engine.deliver(sampleDigest(), { recipients: [] });
    expect(Date.parse(result.deliveredAt)).toBeGreaterThan(0);
  });

  it("returns a well-formed DeliveryResult", async () => {
    const engine = new DigestDeliveryEngine(managerWithDigest(), { now: () => NOW });
    const { result } = await engine.deliver(sampleDigest(), {
      format: "json",
      recipients: [{ address: "a@b.c" }],
    });
    const expected: DeliveryResult = {
      digestId: sampleDigest().id,
      format: "json",
      content: formatDigestAsJson(sampleDigest()),
      recipients: [{ address: "a@b.c" }],
      deliveredAt: NOW,
    };
    expect(result).toEqual(expected);
  });
});

describe("NoopPublisher", () => {
  it("publishes without side effects", async () => {
    const publisher = new NoopPublisher();
    await expect(
      publisher.publish(
        { format: "markdown", recipients: [] },
        "content",
      ),
    ).resolves.toBeUndefined();
  });
});

describe("Delivery determinism and immutability", () => {
  it("identical deliveries produce identical results", async () => {
    const engineA = new DigestDeliveryEngine(managerWithDigest(), { now: () => NOW });
    const engineB = new DigestDeliveryEngine(managerWithDigest(), { now: () => NOW });
    const digest = sampleDigest();
    const options = { recipients: [{ address: "x@y.z" }] };
    const a = await engineA.deliver(digest, options);
    const b = await engineB.deliver(digest, options);
    expect(a.result).toEqual(b.result);
    expect(a.manager.list()).toEqual(b.manager.list());
  });

  it("delivering never mutates the input digest", () => {
    const digest = sampleDigest();
    const engine = new DigestDeliveryEngine(managerWithDigest(), { now: () => NOW });
    void engine.deliver(digest, { recipients: [] }).then(() => {
      expect(digest.metadata.delivery).toBeUndefined();
    });
  });
});
