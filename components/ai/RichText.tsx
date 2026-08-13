"use client";

import React from "react";
import type { InlineSegment } from "./types";

/** Render parsed inline segments as styled text — raw markdown never reaches the DOM. */
export function RichText({ segments }: { segments: InlineSegment[] }) {
  return (
    <>
      {segments.map((segment, index) => {
        switch (segment.kind) {
          case "bold":
            return (
              <strong key={index} className="font-bold text-zinc-900 dark:text-white">
                {segment.text}
              </strong>
            );
          case "italic":
            return <em key={index}>{segment.text}</em>;
          case "code":
            return (
              <code
                key={index}
                className="rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[0.9em] text-brand-700 dark:bg-zinc-800 dark:text-brand-300"
              >
                {segment.text}
              </code>
            );
          case "link":
            return (
              <a
                key={index}
                href={segment.url}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-brand-600 underline decoration-brand-300 underline-offset-2 transition-colors hover:text-brand-500 dark:text-brand-400 dark:decoration-brand-800"
              >
                {segment.text}
              </a>
            );
          default:
            return <React.Fragment key={index}>{segment.text}</React.Fragment>;
        }
      })}
    </>
  );
}

/** Render a single line of text (used by list items / labels). */
export function RichLine({ segments }: { segments: InlineSegment[] }) {
  return (
    <span className="[overflow-wrap:anywhere]">
      <RichText segments={segments} />
    </span>
  );
}
