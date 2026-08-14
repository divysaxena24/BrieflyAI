"use client";

import React from "react";
import { motion } from "framer-motion";

export interface PageHeaderProps {
  title: string;
  description: string;
  badge?: string;
  action?: React.ReactNode;
  aiReady?: boolean;
  lastSync?: string;
  platformsAvailable?: number;
  /** Hide the AI Status banner (e.g. on pages where it isn't relevant). */
  hideAiStatus?: boolean;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  description,
  badge,
  action,
  aiReady = true,
  lastSync = "2 minutes ago",
  platformsAvailable = 6,
  hideAiStatus = false,
}) => {
  return (
    <div className="mb-8 space-y-6">
      {/* Hero Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"
      >
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-black tracking-tight text-zinc-900 dark:text-white sm:text-3xl">
              {title}
            </h1>
            {badge && (
              <span className="inline-flex items-center rounded-full bg-brand-100 px-2.5 py-0.5 text-xs font-bold text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
                {badge}
              </span>
            )}
          </div>
          <p className="max-w-xl text-sm font-medium text-zinc-500 dark:text-zinc-400">
            {description}
          </p>
        </div>

        {action && <div className="flex items-center gap-3">{action}</div>}
      </motion.div>

      {/* AI Status Banner */}
      {!hideAiStatus && (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
        className="flex flex-col gap-4 rounded-2xl border border-zinc-200/80 bg-gradient-to-br from-white to-zinc-50 p-5 shadow-sm dark:border-zinc-800/80 dark:from-zinc-900 dark:to-zinc-900/90 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-center gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-950/40 dark:text-brand-400">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-zinc-900 dark:text-white">
                AI Status
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {aiReady ? "AI Ready" : "Limited"}
              </span>
            </div>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Monitoring <span className="font-semibold text-zinc-700 dark:text-zinc-300">{platformsAvailable}</span> connected platforms • Last sync: <span className="font-semibold text-zinc-700 dark:text-zinc-300">{lastSync}</span>
            </p>
          </div>
        </div>
      </motion.div>
      )}
    </div>
  );
};
