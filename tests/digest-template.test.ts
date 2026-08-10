import { describe, expect, it } from "vitest";
import {
  EVENING_TEMPLATE,
  MORNING_TEMPLATE,
  WEEKLY_TEMPLATE,
  TEMPLATES_BY_KIND,
  MorningDigestBuilder,
  EveningDigestBuilder,
  WeeklyDigestBuilder,
  templateWindowFor,
} from "@/lib/digest/templates";
import { DigestBuilder, type DigestDataSources } from "@/lib/digest/builder";
import { createDigestTemplate, type DigestTemplate } from "@/lib/digest/types";

const NOW = "2026-08-10T12:00:00.000Z";

function fakeSources(): DigestDataSources {
  return {
    listMemories: () => [],
    listConversations: () => [],
    buildContextPrompt: async () => "ctx",
    listJobs: () => [],
    executeTools: async (plan) => ({
      planId: plan.id,
      results: [],
      succeededStepIds: [],
      failedStepIds: [],
      cancelledStepIds: [],
    }),
  };
}

describe("Digest templates", () => {
  it("each template defines a title, kind, priority, and window days", () => {
    expect(MORNING_TEMPLATE.kind).toBe("morning");
    expect(MORNING_TEMPLATE.title).toBe("Morning Digest");
    expect(MORNING_TEMPLATE.priority).toBe("high");
    expect(MORNING_TEMPLATE.windowDays).toBe(1);

    expect(EVENING_TEMPLATE.kind).toBe("evening");
    expect(EVENING_TEMPLATE.windowDays).toBe(1);

    expect(WEEKLY_TEMPLATE.kind).toBe("weekly");
    expect(WEEKLY_TEMPLATE.windowDays).toBe(7);
    expect(WEEKLY_TEMPLATE.priority).toBe("normal");
  });

  it("section categories are unique within each template", () => {
    for (const template of [MORNING_TEMPLATE, EVENING_TEMPLATE, WEEKLY_TEMPLATE]) {
      const categories = template.sections.map((section) => section.category);
      expect(new Set(categories).size).toBe(categories.length);
    }
  });

  it("morning and weekly templates cover every content category", () => {
    const morning = new Set(MORNING_TEMPLATE.sections.map((s) => s.category));
    for (const category of [
      "calendar",
      "emails",
      "github",
      "memories",
      "conversation",
      "actions",
      "files",
    ]) {
      expect(morning.has(category)).toBe(true);
    }
    const weekly = new Set(WEEKLY_TEMPLATE.sections.map((s) => s.category));
    for (const category of morning) {
      expect(weekly.has(category)).toBe(true);
    }
  });

  it("sections carry titles, priorities, and caps", () => {
    const calendar = MORNING_TEMPLATE.sections.find((s) => s.category === "calendar");
    expect(calendar?.title).toBe("Today's Meetings");
    expect(calendar?.priority).toBe("high");
    expect(calendar?.maxItems).toBe(8);
    const conversation = WEEKLY_TEMPLATE.sections.find((s) => s.category === "conversation");
    expect(conversation?.maxItems).toBe(1);
  });

  it("TEMPLATES_BY_KIND covers all built-in kinds", () => {
    expect(TEMPLATES_BY_KIND.morning).toBe(MORNING_TEMPLATE);
    expect(TEMPLATES_BY_KIND.evening).toBe(EVENING_TEMPLATE);
    expect(TEMPLATES_BY_KIND.weekly).toBe(WEEKLY_TEMPLATE);
    expect(Object.keys(TEMPLATES_BY_KIND).sort()).toEqual(["evening", "morning", "weekly"]);
  });

  it("rejects duplicate section categories at construction", () => {
    expect(() =>
      createDigestTemplate({
        id: "template-bad",
        kind: "custom",
        title: "Bad",
        sections: [
          { category: "emails", title: "A", priority: "normal" },
          { category: "emails", title: "B", priority: "normal" },
        ],
      }),
    ).toThrow(/duplicate section category "emails"/);
  });

  it("copies template sections as detached objects", () => {
    const inputSections = [{ category: "emails" as const, title: "E", priority: "normal" as const, maxItems: 5 }];
    const template = createDigestTemplate({
      id: "template-t",
      kind: "custom",
      title: "T",
      sections: inputSections,
    });
    const section = template.sections[0];
    expect(section).not.toBe(inputSections[0]);
    expect(section.maxItems).toBe(5);
    // Mutating the caller's array after construction never affects the template.
    inputSections.length = 0;
    expect(template.sections).toHaveLength(1);
  });
});

describe("Template builders", () => {
  it("MorningDigestBuilder builds morning digests through the shared builder", async () => {
    let template: DigestTemplate | undefined;
    const shared = new DigestBuilder({
      ...fakeSources(),
      buildContextPrompt: async () => "ctx",
    });
    const spy = new DigestBuilderProxy(shared, (t) => {
      template = t;
    });
    const builder = new MorningDigestBuilder(spy);
    const digest = await builder.build({ userId: "u", now: NOW });
    expect(template?.kind).toBe("morning");
    expect(digest.metadata.kind).toBe("morning");
    expect(digest.metadata.title).toBe("Morning Digest");
  });

  it("EveningDigestBuilder builds evening digests", async () => {
    let template: DigestTemplate | undefined;
    const spy = new DigestBuilderProxy(new DigestBuilder(fakeSources()), (t) => {
      template = t;
    });
    const digest = await new EveningDigestBuilder(spy).build({ userId: "u", now: NOW });
    expect(template?.kind).toBe("evening");
    expect(digest.metadata.kind).toBe("evening");
    expect(digest.metadata.title).toBe("Evening Digest");
  });

  it("WeeklyDigestBuilder builds weekly digests", async () => {
    let template: DigestTemplate | undefined;
    const spy = new DigestBuilderProxy(new DigestBuilder(fakeSources()), (t) => {
      template = t;
    });
    const digest = await new WeeklyDigestBuilder(spy).build({ userId: "u", now: NOW });
    expect(template?.kind).toBe("weekly");
    expect(digest.metadata.kind).toBe("weekly");
    expect(digest.metadata.title).toBe("Weekly Digest");
  });

  it("each template builder forwards window semantics", async () => {
    const morning = await new MorningDigestBuilder(new DigestBuilder(fakeSources())).build({
      userId: "u",
      now: NOW,
    });
    expect(morning.metadata.window.from).toBe("2026-08-10T00:00:00.000Z");

    const weekly = await new WeeklyDigestBuilder(new DigestBuilder(fakeSources())).build({
      userId: "u",
      now: NOW,
    });
    expect(weekly.metadata.window.from).toBe("2026-08-03T12:00:00.000Z");
  });

  it("templateWindowFor is re-exported", () => {
    expect(typeof templateWindowFor).toBe("function");
  });

  it("builders are deterministic across runs", async () => {
    const shared = new DigestBuilder(fakeSources());
    const a = await new MorningDigestBuilder(shared).build({ userId: "u", now: NOW });
    const b = await new MorningDigestBuilder(shared).build({ userId: "u", now: NOW });
    expect(a).toEqual(b);
  });
});

/** Thin wrapper to observe which template a builder forwards. */
class DigestBuilderProxy {
  constructor(
    private readonly inner: DigestBuilder,
    private readonly onBuild: (template: DigestTemplate) => void,
  ) {}

  build(input: Parameters<DigestBuilder["build"]>[0]): ReturnType<DigestBuilder["build"]> {
    this.onBuild(input.template);
    return this.inner.build(input);
  }
}
