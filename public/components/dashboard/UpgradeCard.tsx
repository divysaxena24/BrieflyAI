"use client";

import React from "react";
import Link from "next/link";
import { UpgradeZapIcon, AiSparklesIcon } from "./icons";

interface UpgradeCardProps {
  isCollapsed?: boolean;
}

export const UpgradeCard: React.FC<UpgradeCardProps> = ({ isCollapsed = false }) => {
  if (isCollapsed) {
    return (
      <div className="group relative flex justify-center py-2">
        <Link
          href="/dashboard/pricing"
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-amber-500 text-white shadow-md shadow-brand-500/20 transition-all hover:scale-105 active:scale-95"
          title="Upgrade to Pro"
        >
          <UpgradeZapIcon size={20} className="h-5 w-5 fill-current" />
        </Link>
        <div className="pointer-events-none absolute left-full ml-3 z-50 hidden rounded-md bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-xl group-hover:block dark:bg-zinc-800 whitespace-nowrap">
          Upgrade to Pro
        </div>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-brand-200/60 bg-gradient-to-br from-brand-50 via-white to-amber-50/50 p-4 shadow-sm transition-all dark:border-brand-900/40 dark:from-brand-950/40 dark:via-zinc-900 dark:to-amber-950/20">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white shadow-sm dark:bg-brand-500">
          <AiSparklesIcon size={16} className="h-4 w-4" />
        </div>
        <span className="inline-flex items-center rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase text-brand-700 dark:bg-brand-900/60 dark:text-brand-300">
          Pro Plan
        </span>
      </div>

      <div className="mt-3">
        <h4 className="text-xs font-bold text-zinc-900 dark:text-zinc-100">
          Unlock Unlimited AI
        </h4>
        <p className="mt-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
          Get priority processing, custom agents & unlimited summaries.
        </p>
      </div>

      <Link
        href="/dashboard/pricing"
        className="mt-3.5 flex w-full items-center justify-center gap-1.5 rounded-xl bg-brand-600 py-2 px-3 text-xs font-semibold text-white shadow-md shadow-brand-600/20 transition-all hover:bg-brand-500 hover:shadow-brand-600/30 active:scale-[0.98] dark:bg-brand-500 dark:hover:bg-brand-400"
      >
        <UpgradeZapIcon size={14} className="h-3.5 w-3.5 fill-current" />
        Upgrade Now
      </Link>

      {/* Decorative gradient glow */}
      <div className="pointer-events-none absolute -right-6 -top-6 h-16 w-16 rounded-full bg-brand-400/20 blur-xl dark:bg-brand-500/10" />
    </div>
  );
};
