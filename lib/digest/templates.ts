/**
 * Daily AI Digest — digest templates.
 *
 * The Morning, Evening, and Weekly digest templates plus their thin
 * builders. Each template defines its own title, section list (with titles,
 * priorities, and item caps), and window semantics; the shared
 * `DigestBuilder` performs all assembly — no logic is duplicated here.
 *
 * All templates are pure data (frozen by construction via `createDigestTemplate`)
 * and all builders are pure orchestration.
 */

import {
  DigestBuilder,
  templateWindowFor,
  type BuildDigestInput,
} from "./builder";
import {
  createDigestTemplate,
  type Digest,
  type DigestKind,
  type DigestTemplate,
} from "./types";

/** The morning digest template — a day-window digest of today's signals. */
export const MORNING_TEMPLATE: DigestTemplate = createDigestTemplate({
  id: "template-morning",
  kind: "morning",
  title: "Morning Digest",
  priority: "high",
  windowDays: 1,
  sections: [
    { category: "calendar", title: "Today's Meetings", priority: "high", maxItems: 8 },
    { category: "emails", title: "Important Emails", priority: "high", maxItems: 8 },
    { category: "github", title: "GitHub Activity", priority: "normal", maxItems: 8 },
    { category: "memories", title: "Recent Memories", priority: "normal", maxItems: 8 },
    { category: "conversation", title: "Conversation Summary", priority: "normal", maxItems: 1 },
    { category: "actions", title: "Pending Actions", priority: "high", maxItems: 8 },
    { category: "files", title: "Important Files", priority: "normal", maxItems: 8 },
  ],
});

/** The evening digest template — a day-window digest of today's signals. */
export const EVENING_TEMPLATE: DigestTemplate = createDigestTemplate({
  id: "template-evening",
  kind: "evening",
  title: "Evening Digest",
  priority: "high",
  windowDays: 1,
  sections: [
    { category: "calendar", title: "Calendar", priority: "high", maxItems: 8 },
    { category: "emails", title: "Important Emails", priority: "normal", maxItems: 8 },
    { category: "github", title: "GitHub Activity", priority: "normal", maxItems: 8 },
    { category: "files", title: "Important Files", priority: "normal", maxItems: 8 },
    { category: "actions", title: "Pending Actions", priority: "high", maxItems: 8 },
  ],
});

/** The weekly digest template — a 7-day window across all sections. */
export const WEEKLY_TEMPLATE: DigestTemplate = createDigestTemplate({
  id: "template-weekly",
  kind: "weekly",
  title: "Weekly Digest",
  priority: "normal",
  windowDays: 7,
  sections: [
    { category: "calendar", title: "Calendar", priority: "high", maxItems: 12 },
    { category: "emails", title: "Important Emails", priority: "high", maxItems: 12 },
    { category: "github", title: "GitHub Activity", priority: "normal", maxItems: 12 },
    { category: "memories", title: "Recent Memories", priority: "normal", maxItems: 12 },
    { category: "conversation", title: "Conversation Summary", priority: "normal", maxItems: 1 },
    { category: "actions", title: "Pending Actions", priority: "high", maxItems: 12 },
    { category: "files", title: "Important Files", priority: "normal", maxItems: 12 },
  ],
});

/** The three built-in templates by kind (excludes the `custom` kind). */
export const TEMPLATES_BY_KIND: Readonly<
  Record<Exclude<DigestKind, "custom">, DigestTemplate>
> = Object.freeze({
  morning: MORNING_TEMPLATE,
  evening: EVENING_TEMPLATE,
  weekly: WEEKLY_TEMPLATE,
});

/**
 * The morning digest builder: builds `MORNING_TEMPLATE` digests through the
 * shared `DigestBuilder`.
 */
export class MorningDigestBuilder {
  constructor(private readonly builder: DigestBuilder) {}

  build(input: Omit<BuildDigestInput, "template">): Promise<Digest> {
    return this.builder.build({ ...input, template: MORNING_TEMPLATE });
  }
}

/**
 * The evening digest builder: builds `EVENING_TEMPLATE` digests through the
 * shared `DigestBuilder`.
 */
export class EveningDigestBuilder {
  constructor(private readonly builder: DigestBuilder) {}

  build(input: Omit<BuildDigestInput, "template">): Promise<Digest> {
    return this.builder.build({ ...input, template: EVENING_TEMPLATE });
  }
}

/**
 * The weekly digest builder: builds `WEEKLY_TEMPLATE` digests through the
 * shared `DigestBuilder`.
 */
export class WeeklyDigestBuilder {
  constructor(private readonly builder: DigestBuilder) {}

  build(input: Omit<BuildDigestInput, "template">): Promise<Digest> {
    return this.builder.build({ ...input, template: WEEKLY_TEMPLATE });
  }
}

/** Resolve a template's window at `now` (re-exported for convenience). */
export { templateWindowFor };

/** Build digest input without a template (template injected by builders). */
export type { BuildDigestInput };
