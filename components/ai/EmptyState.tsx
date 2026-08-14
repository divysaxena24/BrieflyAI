"use client";

import React from "react";
import { InfoIcon } from "@/components/dashboard/icons";
import { emptyMessage, emptySuggestions, INTEGRATIONS } from "./meta";
import type { IntegrationName } from "./types";

interface EmptyStateProps {
  integration?: IntegrationName | null;
  /** Optional friendly headline override, e.g. "No meetings tomorrow". */
  title?: string;
}

/**
 * Friendly empty state. Never shows "No data" — instead a warm message and
 * follow-up suggestions so the user always has a next step.
 */
export function EmptyState({ integration, title }: EmptyStateProps) {
  const meta = integration ? INTEGRATIONS[integration] : null;
  const Icon = meta?.icon;
  const suggestions = emptySuggestions(integration ?? null);

  return (
    <div className="flex flex-col items-start gap-3 rounded-2xl border border-zinc-200/80 bg-gradient-to-br from-white to-zinc-50/80 p-5 shadow-sm dark:border-zinc-800/80 dark:from-zinc-900 dark:to-zinc-900/80">
      <div className="flex items-center gap-3">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-xl shadow-sm ${
            meta?.iconBg ?? "bg-zinc-100 dark:bg-zinc-800"
          }`}
        >
          {Icon ? (
            <Icon size={18} className={`h-5 w-5 ${meta?.iconColor ?? "text-zinc-500 dark:text-zinc-300"}`} />
          ) : (
            <InfoIcon size={18} className="h-5 w-5 text-brand-500" />
          )}
        </div>
        <div>
          <p className="text-sm font-bold text-zinc-900 dark:text-white">
            {title ?? emptyMessage(integration ?? null)}
          </p>
          {integration && (
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              Nothing to show right now — here&apos;s what to try next.
            </p>
          )}
        </div>
      </div>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((suggestion) => (
            <span
              key={suggestion}
              className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-600 shadow-sm transition-colors hover:border-brand-200 hover:text-brand-700 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300 dark:hover:border-brand-800 dark:hover:text-brand-300"
            >
              {suggestion}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
