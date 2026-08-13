"use client";

import React from "react";

/** Skeleton of the structured response card, shown while the request runs. */
export function AiResponseSkeleton({ label }: { label?: string }) {
  return (
    <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
      <div className="flex items-start gap-3">
        <div className="h-11 w-11 animate-pulse rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-2/5 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-3 w-1/4 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800/60" />
        </div>
      </div>
      <div className="mt-4 space-y-2">
        <div className="h-3 w-full animate-pulse rounded bg-zinc-100 dark:bg-zinc-800/60" />
        <div className="h-3 w-11/12 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800/60" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800/60" />
      </div>
      <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
        <div className="h-16 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-800/60" />
        <div className="h-16 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-800/60" />
      </div>
      {label && <p className="mt-3 text-[11px] text-zinc-400 dark:text-zinc-500">{label}</p>}
    </div>
  );
}
