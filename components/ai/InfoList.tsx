"use client";

import React from "react";
import { CheckCircleIcon } from "@/components/dashboard/icons";
import { RichText, RichLine } from "./RichText";
import { splitLabel } from "./InsightSection";
import type { InlineSegment } from "./types";

/**
 * Renders a list as either:
 * - definition rows, when items look like `**Label:** value` pairs, or
 * - styled bullet items (with a check marker) otherwise.
 */
export function InfoList({ items }: { items: InlineSegment[][] }) {
  if (!items || items.length === 0) return null;

  const labelled = items.every((item) => splitLabel(item).label !== null);

  if (labelled) {
    return (
      <dl className="divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-sm dark:divide-zinc-800/80 dark:border-zinc-800/80 dark:bg-zinc-900/90">
        {items.map((item, index) => {
          const { label, rest } = splitLabel(item);
          return (
            <div
              key={index}
              className="flex flex-col gap-1 px-4 py-2.5 transition-colors hover:bg-zinc-50/80 sm:flex-row sm:items-baseline sm:gap-4 dark:hover:bg-zinc-800/40"
            >
              <dt className="w-full shrink-0 text-xs font-bold text-zinc-900 dark:text-white sm:w-40">
                {label}
              </dt>
              <dd className="min-w-0 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400 [overflow-wrap:anywhere]">
                <RichText segments={rest} />
              </dd>
            </div>
          );
        })}
      </dl>
    );
  }

  return (
    <ul className="space-y-1.5">
      {items.map((item, index) => (
        <li key={index} className="flex items-start gap-2.5 text-sm leading-relaxed">
          <CheckCircleIcon
            size={14}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500 dark:text-brand-400"
          />
          <span className="min-w-0 text-zinc-700 dark:text-zinc-300">
            <RichLine segments={item} />
          </span>
        </li>
      ))}
    </ul>
  );
}
