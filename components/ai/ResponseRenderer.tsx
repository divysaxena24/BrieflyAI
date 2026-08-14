"use client";

import React, { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AiSparklesIcon, ChevronDownIcon, ExternalLinkIcon, InfoIcon } from "@/components/dashboard/icons";
import { parseResponse } from "./markdown";
import { ResponseHeader } from "./ResponseHeader";
import { SummarySection } from "./SummarySection";
import { InsightSection } from "./InsightSection";
import { ActionSection } from "./ActionSection";
import { InfoList } from "./InfoList";
import { SourceList } from "./SourceList";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { RichText } from "./RichText";
import { integrationOf, toolTitle } from "./meta";
import type { AISource, ContentBlock, InlineSegment, IntegrationName } from "./types";

export interface ResponseRendererProps {
  /** The raw LLM response text (parsed into structure internally). */
  content: string;
  /** Tool id, e.g. "gmail.summarizeInbox". */
  tool?: string;
  /** Source references from the API. */
  sources?: readonly AISource[];
  /** Backend note (e.g. data limitation). */
  note?: string;
  /** Set when summarization failed but tool data was still retrieved. */
  aiError?: { code: string; message: string };
  /** Raw tool data (used for empty-state hints / counts). */
  data?: Record<string, unknown>;
  /** When provided, shows the regenerate action. */
  onRegenerate?: () => void;
}

/** Prose paragraph used inside generic sections. */
function Prose({ segments }: { segments: InlineSegment[] }) {
  return (
    <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300 [overflow-wrap:anywhere]">
      <RichText segments={segments} />
    </p>
  );
}

/** Links extracted from a sources section in the parsed content. */
function LinkRows({ items }: { items: InlineSegment[][] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item, index) => (
        <li key={index} className="flex items-start gap-2.5 text-sm leading-relaxed">
          <ExternalLinkIcon size={13} className="mt-1 h-3.5 w-3.5 shrink-0 text-brand-500 dark:text-brand-400" />
          <span className="min-w-0 text-zinc-700 dark:text-zinc-300">
            <RichText segments={item} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Render arbitrary blocks (paragraphs / lists / quotes) in order. */
function renderBlocks(blocks: ContentBlock[]) {
  return blocks.map((block, index) => {
    switch (block.kind) {
      case "paragraph":
        return <Prose key={index} segments={block.segments} />;
      case "list":
        return <InfoList key={index} items={block.items} />;
      case "quote":
        return (
          <blockquote
            key={index}
            className="border-l-2 border-brand-300 pl-3 text-sm italic leading-relaxed text-zinc-600 dark:border-brand-700 dark:text-zinc-400"
          >
            <RichText segments={block.segments} />
          </blockquote>
        );
      default:
        return null;
    }
  });
}

/** Pull the list items out of a section (used by insights/actions). */
function sectionItems(blocks: ContentBlock[]): InlineSegment[][] | null {
  for (const block of blocks) {
    if (block.kind === "list" && block.items.length > 0) return block.items;
  }
  return null;
}

/**
 * A heading-based section rendered as a collapsible block — every section of
 * the response can be collapsed so long responses stay scannable.
 */
function CollapsibleSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="border-t border-zinc-100 pt-3.5 first:border-t-0 first:pt-0 dark:border-zinc-800/70">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="group flex w-full items-center justify-between gap-3 py-0.5 text-left"
      >
        <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-400 transition-colors group-hover:text-zinc-600 dark:text-zinc-500 dark:group-hover:text-zinc-300">
          <AiSparklesIcon size={11} className="h-3 w-3 text-brand-500 dark:text-brand-400" />
          {title}
        </span>
        <ChevronDownIcon
          size={14}
          className={`h-3.5 w-3.5 shrink-0 text-zinc-300 transition-transform duration-200 group-hover:text-zinc-500 dark:text-zinc-600 dark:group-hover:text-zinc-400 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="pt-2.5">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

/**
 * Renders an AI response as a structured, premium card — never raw markdown.
 * Layout: header → summary → collapsible sections → sources.
 */
export function ResponseRenderer({
  content,
  tool,
  sources,
  note,
  aiError,
  onRegenerate,
}: ResponseRendererProps) {
  const integration: IntegrationName | null = integrationOf(tool);
  const parsed = parseResponse(content);

  // Request-level failures (no content at all).
  if ((!content || content.trim().length === 0) && aiError) {
    return <ErrorState message={aiError.message} code={aiError.code} integration={integration} />;
  }

  // Empty responses become friendly empty states.
  if (parsed.empty) {
    return <EmptyState integration={integration} />;
  }

  const title = parsed.title ?? toolTitle(tool);

  const leadParagraphs: InlineSegment[][] = [];
  const leadExtras: ContentBlock[] = [];
  for (const block of parsed.leading) {
    if (block.kind === "paragraph") leadParagraphs.push(block.segments);
    else leadExtras.push(block);
  }

  return (
    <div className="animate-fade-in-up overflow-hidden rounded-3xl rounded-tl-md border border-zinc-200/80 bg-white shadow-sm transition-shadow duration-300 hover:shadow-md dark:border-zinc-800/80 dark:bg-zinc-900/90">
      {/* Header */}
      <div className="border-b border-zinc-100 bg-gradient-to-b from-zinc-50/60 to-transparent px-5 py-4 dark:border-zinc-800/60 dark:from-zinc-800/20">
        <ResponseHeader
          title={title}
          integration={integration}
          tool={tool}
          copyText={content}
          onRegenerate={onRegenerate}
        />
      </div>

      {/* Body */}
      <div className="space-y-4 px-5 py-5">
        {aiError && (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
            AI summarization was unavailable ({aiError.message}) — showing the retrieved data.
          </p>
        )}

        {/* Summary: first 2–3 lines, no bullets. */}
        {leadParagraphs.length > 0 && (
          <SummarySection segments={leadParagraphs.flat()} />
        )}

        {/* Leading highlights / lists without a heading. */}
        {leadExtras.map((block, index) => {
          if (block.kind === "list") return <InsightSection key={index} items={block.items} />;
          return (
            <div key={index} className="space-y-2">
              {renderBlocks([block])}
            </div>
          );
        })}

        {/* Heading-based sections (collapsible). */}
        {parsed.sections.map((section, sectionIndex) => {
          if (section.kind === "actions") {
            const items = sectionItems(section.blocks);
            const prose = section.blocks.filter((b) => b.kind === "paragraph");
            return (
              <CollapsibleSection key={sectionIndex} title={section.title}>
                <div className="space-y-2.5">
                  {items && <ActionSection items={items} />}
                  {prose.length > 0 && <div className="space-y-2">{renderBlocks(prose)}</div>}
                </div>
              </CollapsibleSection>
            );
          }
          if (section.kind === "insights") {
            const items = sectionItems(section.blocks);
            const rest = section.blocks.filter((b) => b.kind !== "list");
            return (
              <CollapsibleSection key={sectionIndex} title={section.title}>
                <div className="space-y-2.5">
                  {items && <InsightSection items={items} />}
                  {rest.length > 0 && <div className="space-y-2">{renderBlocks(rest)}</div>}
                </div>
              </CollapsibleSection>
            );
          }
          if (section.kind === "sources") {
            const items = sectionItems(section.blocks);
            return (
              <CollapsibleSection key={sectionIndex} title={section.title}>
                {items ? <LinkRows items={items} /> : renderBlocks(section.blocks)}
              </CollapsibleSection>
            );
          }
          return (
            <CollapsibleSection key={sectionIndex} title={section.title}>
              <div className="space-y-2.5">{renderBlocks(section.blocks)}</div>
            </CollapsibleSection>
          );
        })}
      </div>

      {/* Sources from the API (collapsible). */}
      {sources && sources.length > 0 && (
        <div className="border-t border-zinc-100 px-5 py-4 dark:border-zinc-800/60">
          <SourceList sources={sources} />
        </div>
      )}

      {/* Footer note. */}
      {note && (
        <div className="flex items-start gap-2 border-t border-zinc-100 px-5 py-3 dark:border-zinc-800/60">
          <InfoIcon size={13} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
          <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{note}</p>
        </div>
      )}
    </div>
  );
}
