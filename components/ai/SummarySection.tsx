"use client";

import React from "react";
import { RichText } from "./RichText";
import type { InlineSegment } from "./types";

/** A concise, scannable summary — prose only, never bullets. */
export function SummarySection({ segments }: { segments: InlineSegment[] }) {
  if (!segments || segments.length === 0) return null;
  return (
    <p className="max-w-prose text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
      <RichText segments={segments} />
    </p>
  );
}

/** Join several leading paragraphs into a short summary (keeps it to a few lines). */
export function SummaryFromParagraphs({ paragraphs }: { paragraphs: InlineSegment[][] }) {
  const flat = paragraphs.flat();
  if (flat.length === 0) return null;
  return <SummarySection segments={flat} />;
}
