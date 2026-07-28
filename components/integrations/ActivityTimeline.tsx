"use client";

import React from "react";
import { motion } from "framer-motion";
import { PlatformIcon } from "./PlatformIcon";

export interface ActivityEntry {
  id: string;
  platformId: string;
  action: string;
  timestamp: string;
  type: "connected" | "disconnected" | "synced" | "refreshed" | "error" | "configured";
}

interface ActivityTimelineProps {
  activities: ActivityEntry[];
}

const typeColors: Record<string, string> = {
  connected: "bg-emerald-500",
  disconnected: "bg-red-500",
  synced: "bg-sky-500",
  refreshed: "bg-brand-500",
  error: "bg-red-500",
  configured: "bg-amber-500",
};

export const ActivityTimeline: React.FC<ActivityTimelineProps> = ({ activities }) => {
  if (activities.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-6 text-center">
        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-100 dark:bg-zinc-800">
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
        </div>
        <p className="text-xs font-medium text-zinc-400 dark:text-zinc-500">
          No recent activity
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {activities.map((activity, index) => {
        const dotColor = typeColors[activity.type] ?? "bg-zinc-400";

        return (
          <motion.div
            key={activity.id}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.25, delay: index * 0.05 }}
            className="flex items-start gap-3"
          >
            <div className="flex flex-col items-center">
              <div
                className={`mt-1.5 flex h-6 w-6 items-center justify-center rounded-full ${dotColor} ring-2 ring-zinc-100 dark:ring-zinc-800`}
              >
                <PlatformIcon platformId={activity.platformId} size={12} className="text-white" />
              </div>
              {index < activities.length - 1 && (
                <div className="mt-1 h-full w-px bg-zinc-200 dark:bg-zinc-700" />
              )}
            </div>
            <div className="flex-1 pb-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-zinc-900 dark:text-white">
                  {activity.action}
                </p>
                <span className="text-[10px] text-zinc-400 dark:text-zinc-500 shrink-0 ml-2">
                  {activity.timestamp}
                </span>
              </div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
};
