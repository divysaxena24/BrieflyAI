/**
 * AI response rendering — shared types.
 *
 * The LLM returns free-form markdown; the renderer parses it into these
 * structured blocks and renders them as UI components (never raw markdown).
 */

/** Inline rich-text segment. No raw markdown ever reaches the DOM. */
export type InlineSegment =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; url: string };

/** A top-level content block produced by the markdown parser. */
export type ContentBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; segments: InlineSegment[] }
  | { kind: "list"; ordered: boolean; items: InlineSegment[][] }
  | { kind: "quote"; segments: InlineSegment[] };

/** How a heading-based section should be rendered. */
export type SectionKind = "actions" | "insights" | "sources" | "generic";

/** A heading-grouped section of the response. */
export interface ParsedSection {
  title: string;
  kind: SectionKind;
  blocks: ContentBlock[];
}

/** The fully parsed AI response. */
export interface ParsedResponse {
  /** First heading in the response, used as the card title. */
  title: string | null;
  /** Blocks before the first heading (summary + lead content). */
  leading: ContentBlock[];
  /** Heading-grouped sections. */
  sections: ParsedSection[];
  /** True when the response carries no real content. */
  empty: boolean;
}

/** A source reference returned by the API (never a secret). */
export interface AISource {
  integration: string;
  type: string;
  id: string;
  title?: string;
  url?: string;
}

/** The six integration families the AI tools operate on. */
export type IntegrationName = "gmail" | "calendar" | "drive" | "github" | "discord" | "telegram";
