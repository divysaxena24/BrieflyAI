"use client";

import React from "react";
import { AiSparklesIcon } from "@/components/dashboard/icons";

/**
 * Loading state for an in-flight AI request.
 *
 * Mirrors the assistant bubble layout: animated gradient orb avatar on the
 * left, then a card with streaming dots + a status label ("Finding the right
 * tool…", "Generating summary…") and shimmering content lines.
 */
export function AiResponseSkeleton({ label }: { label?: string }) {
  return (
    <div className="flex items-start gap-3">
      {/* Orb avatar */}
      <div className="ai-orb flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white shadow-md shadow-brand-500/30">
        <AiSparklesIcon size={16} className="h-4 w-4" />
      </div>

      {/* Card */}
      <div className="min-w-0 flex-1 rounded-3xl rounded-tl-md border border-zinc-200/80 bg-white p-4 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
        <div className="flex items-center gap-2.5">
          <span className="streaming-dots flex items-center gap-1 text-brand-500" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">
            {label ?? "Thinking…"}
          </span>
        </div>

        <div className="mt-4 space-y-2.5">
          <div className="h-2.5 w-full animate-pulse rounded-full bg-zinc-100 dark:bg-zinc-800/70" />
          <div className="h-2.5 w-11/12 animate-pulse rounded-full bg-zinc-100 dark:bg-zinc-800/70" />
          <div className="h-2.5 w-4/5 animate-pulse rounded-full bg-zinc-100 dark:bg-zinc-800/70" />
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <div className="h-12 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-800/60" />
          <div className="h-12 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-800/60" />
        </div>
      </div>
    </div>
  );
}
