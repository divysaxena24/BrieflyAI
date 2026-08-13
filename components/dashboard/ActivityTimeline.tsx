"use client";

import React from "react";
import { motion } from "framer-motion";
import { useDashboardData } from "./useDashboardData";
import { PlatformIcon } from "@/components/integrations";
import { formatRelativeTime } from "@/lib/utils/time";
import { ActivityStreamIcon } from "@/components/dashboard/icons";

const dotColors: Record<string, string> = {
  connected: "bg-emerald-500",
  disconnected: "bg-red-500",
  synced: "bg-sky-500",
  refreshed: "bg-brand-500",
  error: "bg-red-500",
  configured: "bg-amber-500",
};

/**
 * AI Activity Timeline: a vertical timeline of the user's real AI and
 * integration activity, newest first, with subtle stagger animations.
 */
export const ActivityTimeline: React.FC = () => {
  const { activities, loading } = useDashboardData();

  return (
    <div className="flex h-full flex-col rounded-3xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-white p-6 dark:bg-zinc-900/90">
        <ActivityStreamIcon size={18} className="h-5 w-5 text-brand-600 dark:text-brand-400" />
        <h2 className="text-base font-bold text-zinc-900 dark:text-white">
          AI Activity Timeline
        </h2>
      </div>

      <div className="scrollbar-thin max-h-[420px] overflow-y-auto px-6 pb-6">
      {loading ? (
        <div className="space-y-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex animate-pulse items-start gap-3">
              <div className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-zinc-200 dark:bg-zinc-700" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-1/2 rounded bg-zinc-200 dark:bg-zinc-800" />
                <div className="h-2.5 w-20 rounded bg-zinc-100 dark:bg-zinc-800" />
              </div>
            </div>
          ))}
        </div>
      ) : activities.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
          <p className="text-xs font-bold text-zinc-700 dark:text-zinc-200">
            No activity yet
          </p>
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
            Your AI and integration activity will show up here.
          </p>
        </div>
      ) : (
        <div className="relative">
          {activities.map((activity, index) => {
            const dotColor = dotColors[activity.type] ?? "bg-zinc-400";
            const isLast = index === activities.length - 1;
            return (
              <motion.div
                key={activity.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: index * 0.06 }}
                className="relative flex items-start gap-3 pb-5 last:pb-0"
              >
                {/* Vertical connector */}
                {!isLast && (
                  <div className="absolute left-[5px] top-4 h-full w-px bg-zinc-200 dark:bg-zinc-700/70" />
                )}
                {/* Dot */}
                <div className={`mt-1.5 h-3 w-3 shrink-0 rounded-full ${dotColor} ring-4 ring-zinc-50 dark:ring-zinc-900`} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-zinc-800 dark:text-zinc-100">
                    {activity.action}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <PlatformIcon
                      platformId={activity.platformId}
                      size={12}
                      className="h-3 w-3 text-zinc-400 dark:text-zinc-500"
                    />
                    {activity.details && (
                      <span className="truncate text-[11px] text-zinc-400 dark:text-zinc-500">
                        {activity.details}
                      </span>
                    )}
                    <span className="shrink-0 text-[10px] font-semibold text-zinc-300 dark:text-zinc-600">
                      {formatRelativeTime(activity.createdAt)}
                    </span>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
      </div>
    </div>
  );
};
