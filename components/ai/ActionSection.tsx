"use client";

import React from "react";
import { ArrowRightIcon, CheckCircleIcon } from "@/components/dashboard/icons";
import { RichText } from "./RichText";
import { splitLabel } from "./InsightSection";
import type { InlineSegment } from "./types";

/** Find a link URL inside a list item, if any. */
function firstLink(segments: InlineSegment[]): string | null {
  for (const segment of segments) {
    if (segment.kind === "link") return segment.url;
  }
  return null;
}

/**
 * Recommended actions rendered as tappable cards/chips. When an item
 * contains a link it becomes a real button; otherwise it's a static chip.
 */
export function ActionSection({ items }: { items: InlineSegment[][] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item, index) => {
        const { label, rest } = splitLabel(item);
        const href = firstLink(item);
        const text = label ?? rest.map((s) => ("text" in s ? s.text : "")).join("").trim();
        const content = (
          <>
            <CheckCircleIcon size={13} className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            <span className="min-w-0 flex-1 truncate text-left text-xs font-bold">
              {text || <RichText segments={rest} />}
            </span>
            <ArrowRightIcon
              size={13}
              className="h-3.5 w-3.5 shrink-0 text-zinc-300 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-500 dark:text-zinc-600"
            />
          </>
        );
        const className =
          "group inline-flex w-full max-w-full items-center gap-2 rounded-xl border border-zinc-200/80 bg-white px-3 py-2.5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-300 hover:bg-brand-50/40 hover:shadow-md active:scale-[0.98] dark:border-zinc-800/80 dark:bg-zinc-900/90 dark:hover:border-brand-800 dark:hover:bg-brand-950/20 sm:w-auto";
        return href ? (
          <a
            key={index}
            href={href}
            target="_blank"
            rel="noreferrer"
            className={`${className} text-zinc-700 hover:text-brand-700 dark:text-zinc-200 dark:hover:text-brand-300`}
          >
            {content}
          </a>
        ) : (
          <div key={index} className={`${className} cursor-default text-zinc-700 dark:text-zinc-200`}>
            {content}
          </div>
        );
      })}
    </div>
  );
}
