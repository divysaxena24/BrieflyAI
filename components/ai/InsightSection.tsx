"use client";

import React from "react";
import { motion } from "framer-motion";
import { RichText } from "./RichText";
import type { InlineSegment } from "./types";

/** Split a list item into a bold label + the remaining description. */
export function splitLabel(segments: InlineSegment[]): { label: string | null; rest: InlineSegment[] } {
  // Leading bold segment, optionally followed by ":" — e.g. "**Odoo Hackathon**: Aug 16".
  if (segments.length > 0 && segments[0].kind === "bold") {
    const rest = segments.slice(1);
    if (rest.length > 0 && rest[0].kind === "text" && rest[0].text.startsWith(":")) {
      rest[0] = { ...rest[0], text: rest[0].text.replace(/^:\s*/, "") };
      if (!rest[0].text) rest.shift();
    }
    return { label: segments[0].text, rest };
  }
  return { label: null, rest: segments };
}

/**
 * Renders bullet items as visually separated insight cards.
 * A `**Label:** description` item becomes a labelled card; plain items become
 * standalone highlight cards.
 */
export function InsightSection({ items }: { items: InlineSegment[][] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      {items.map((item, index) => {
        const { label, rest } = splitLabel(item);
        return (
          <motion.div
            key={index}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: Math.min(index * 0.04, 0.3) }}
            className="rounded-2xl border border-zinc-200/80 bg-white p-3.5 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90"
          >
            <div className="flex items-start gap-2.5">
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-gradient-to-r from-brand-500 to-accent-500 shadow-sm shadow-brand-500/30" />
              <div className="min-w-0">
                {label && (
                  <p className="text-xs font-bold text-zinc-900 dark:text-white">{label}</p>
                )}
                {rest.length > 0 && (
                  <p className="mt-0.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                    <RichText segments={rest} />
                  </p>
                )}
              </div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
