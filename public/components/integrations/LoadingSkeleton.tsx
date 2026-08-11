"use client";

import React from "react";

export const IntegrationCardSkeleton: React.FC = () => (
  <div className="rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90 animate-pulse">
    <div className="absolute inset-x-0 top-0 h-1 rounded-t-2xl bg-zinc-200 dark:bg-zinc-700" />

    <div className="mb-4 flex items-start justify-between">
      <div className="flex items-center gap-3">
        <div className="h-11 w-11 rounded-xl bg-zinc-200 dark:bg-zinc-800" />
        <div>
          <div className="h-4 w-28 rounded-md bg-zinc-200 dark:bg-zinc-800" />
          <div className="mt-1.5 h-3 w-16 rounded-md bg-zinc-100 dark:bg-zinc-800" />
        </div>
      </div>
      <div className="h-5 w-24 rounded-full bg-zinc-200 dark:bg-zinc-800" />
    </div>

    <div className="mb-3 space-y-1.5">
      <div className="h-3 w-full rounded-md bg-zinc-100 dark:bg-zinc-800" />
      <div className="h-3 w-3/4 rounded-md bg-zinc-100 dark:bg-zinc-800" />
    </div>

    <div className="flex items-center gap-2.5">
      <div className="h-4 w-20 rounded-md bg-zinc-100 dark:bg-zinc-800" />
      <div className="h-4 w-28 rounded-md bg-zinc-100 dark:bg-zinc-800" />
    </div>

    <div className="mt-5 flex items-center justify-between border-t border-zinc-100 pt-4 dark:border-zinc-800">
      <div className="flex gap-2">
        <div className="h-8 w-20 rounded-xl bg-zinc-200 dark:bg-zinc-800" />
        <div className="h-8 w-20 rounded-xl bg-zinc-100 dark:bg-zinc-800" />
      </div>
      <div className="h-3 w-12 rounded bg-zinc-100 dark:bg-zinc-800" />
    </div>
  </div>
);

export const IntegrationGridSkeleton: React.FC<{ count?: number }> = ({ count = 8 }) => (
  <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
    {Array.from({ length: count }).map((_, i) => (
      <IntegrationCardSkeleton key={i} />
    ))}
  </div>
);
