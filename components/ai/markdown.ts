/**
 * Lightweight, dependency-free markdown → structured block parser.
 *
 * Handles the subset of markdown the LLM actually emits (headings, bullets,
 * bold, italic, inline code, links, quotes, paragraphs) and converts it into
 * {@link ContentBlock}s. Rendering never happens from raw markdown — the
 * blocks are turned into typed UI components by the renderer.
 */

import type {
  ContentBlock,
  InlineSegment,
  ParsedResponse,
  ParsedSection,
  SectionKind,
} from "./types";

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const LIST_RE = /^\s*([-*+]|\d+\.)\s+(.+)$/;
const QUOTE_RE = /^>\s?(.+)$/;
const INDENTED_RE = /^\s{2,}\S/;
const INLINE_TOKEN = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

/** Parse a line of text into inline rich-text segments. */
export function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_TOKEN)) {
    const idx = match.index ?? 0;
    if (idx > last) segments.push({ kind: "text", text: text.slice(last, idx) });
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      segments.push({ kind: "bold", text: token.slice(2, -2) });
    } else if (token.startsWith("*") && token.endsWith("*")) {
      segments.push({ kind: "italic", text: token.slice(1, -1) });
    } else if (token.startsWith("`") && token.endsWith("`")) {
      segments.push({ kind: "code", text: token.slice(1, -1) });
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) segments.push({ kind: "link", text: link[1], url: link[2] });
      else segments.push({ kind: "text", text: token });
    }
    last = idx + token.length;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}

/** Split raw response text into a flat list of content blocks. */
export function parseBlocks(text: string): ContentBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: ContentBlock[] = [];
  let i = 0;

  const pushParagraph = (acc: string[]) => {
    const joined = acc.join(" ").trim();
    if (joined) blocks.push({ kind: "paragraph", segments: parseInline(joined) });
  };

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      i++;
      continue;
    }

    const heading = trimmed.match(HEADING_RE);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      i++;
      continue;
    }

    const quote = trimmed.match(QUOTE_RE);
    if (quote) {
      blocks.push({ kind: "quote", segments: parseInline(quote[1].trim()) });
      i++;
      continue;
    }

    if (LIST_RE.test(trimmed)) {
      const items: InlineSegment[][] = [];
      let ordered = /^\s*\d+\./.test(trimmed);
      while (i < lines.length) {
        const t = lines[i].trim();
        if (!t) break;
        const m = t.match(LIST_RE);
        if (!m) break;
        if (/\d+\./.test(m[1])) ordered = true;
        const itemLines = [m[2].trim()];
        i++;
        while (i < lines.length && INDENTED_RE.test(lines[i]) && !LIST_RE.test(lines[i].trim())) {
          itemLines.push(lines[i].trim());
          i++;
        }
        items.push(parseInline(itemLines.join(" ")));
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // Plain paragraph — accumulate until a blank or special line.
    const acc = [trimmed];
    i++;
    while (i < lines.length) {
      const t = lines[i].trim();
      if (!t || HEADING_RE.test(t) || QUOTE_RE.test(t) || LIST_RE.test(t)) break;
      acc.push(t);
      i++;
    }
    pushParagraph(acc);
  }

  return blocks;
}

const ACTIONS_RE = /^(recommended\s+actions?|actions?|recommendations?|next\s+steps?|what\s+you\s+should\s+do)$/i;
const INSIGHTS_RE = /^(key\s+insights?|insights?|highlights?|key\s+points?|important\s+(items?|emails?|updates?)|needs\s+attention|what\s+matters\s+most)$/i;
const SOURCES_RE = /^(sources?|references?|links?|related\s+items?)$/i;

/** Classify a heading into a rendering strategy. */
export function classifySection(title: string): SectionKind {
  if (ACTIONS_RE.test(title.trim())) return "actions";
  if (INSIGHTS_RE.test(title.trim())) return "insights";
  if (SOURCES_RE.test(title.trim())) return "sources";
  return "generic";
}

/** Parse a full AI response into title + leading content + sections. */
export function parseResponse(text: string | null | undefined): ParsedResponse {
  const source = (text ?? "").trim();
  if (!source) return { title: null, leading: [], sections: [], empty: true };

  const blocks = parseBlocks(source);

  // Title: only a level-1 heading is the card title. The prompts instruct the
  // LLM to use `##`-level headings for real sections, so those stay as
  // sections and the card title falls back to the tool-derived title.
  const firstHeading = blocks.find((b) => b.kind === "heading");
  const title =
    firstHeading && firstHeading.kind === "heading" && firstHeading.level === 1
      ? firstHeading.text
      : null;

  const leading: ContentBlock[] = [];
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;
  let consumedTitle = false;

  for (const block of blocks) {
    if (block.kind === "heading") {
      if (!consumedTitle && block.level === 1) {
        consumedTitle = true;
        continue; // consumed as the card title
      }
      current = { title: block.text, kind: classifySection(block.text), blocks: [] };
      sections.push(current);
      continue;
    }
    if (current) {
      current.blocks.push(block);
    } else {
      leading.push(block);
    }
  }

  const hasContent = blocks.some((b) => b.kind === "paragraph" || b.kind === "list" || b.kind === "quote");

  // Bare "no data" phrasing should render as a friendly empty state, but a
  // real sentence (e.g. "No meetings tomorrow — enjoy your free day!") is kept.
  const trimmed = source.trim();
  const isNoDataPhrase =
    trimmed.length <= 80 &&
    /^(no data|nothing (found|to show|here|yet)|no results|no items|no .{0,40}?(found|yet|available)|didn'?t find anything)/i.test(
      trimmed,
    );

  return { title, leading, sections, empty: !hasContent || isNoDataPhrase };
}
