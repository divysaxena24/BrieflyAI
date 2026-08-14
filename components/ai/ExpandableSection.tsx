"use client";

import React, { useState } from "react";
import { ChevronDownIcon } from "@/components/dashboard/icons";

interface ExpandableSectionProps<T> {
  items: readonly T[];
  /** Number of items shown before expanding. */
  preview?: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  className?: string;
  /** Label for the expand button, e.g. "Show 12 more". */
  moreLabel?: (hiddenCount: number) => string;
}

/**
 * Renders the first `preview` items and reveals the rest behind a
 * "Show more" toggle — long results are never dumped as one giant list.
 */
export function ExpandableSection<T>({
  items,
  preview = 5,
  renderItem,
  className,
  moreLabel = (n) => `Show ${n} more`,
}: ExpandableSectionProps<T>) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;

  const visible = expanded ? items : items.slice(0, preview);
  const hidden = items.length - visible.length;

  return (
    <div className={className}>
      {visible.map((item, index) => renderItem(item, index))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2.5 inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-3.5 py-1.5 text-[11px] font-bold text-zinc-600 shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-brand-300 hover:text-brand-700 hover:shadow-md active:translate-y-0 dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-300 dark:hover:border-brand-700 dark:hover:text-brand-300"
        >
          {moreLabel(hidden)}
          <ChevronDownIcon size={12} className="h-3 w-3" />
        </button>
      )}
      {expanded && items.length > preview && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-2.5 inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-3.5 py-1.5 text-[11px] font-bold text-zinc-600 shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-brand-300 hover:text-brand-700 hover:shadow-md active:translate-y-0 dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-300 dark:hover:border-brand-700 dark:hover:text-brand-300"
        >
          Show less
          <ChevronDownIcon size={12} className="h-3 w-3 rotate-180" />
        </button>
      )}
    </div>
  );
}
