"use client";

import React from "react";
import { motion } from "framer-motion";
import { PlatformIcon } from "./PlatformIcon";
import { formatRelativeTime } from "@/lib/utils/time";

export interface ActivityEntry {
  id: string;
  platformId: string;
  action: string;
  details?: string | null;
  type: string;
  createdAt: string;
}

interface ActivityTimelineProps {
  activities: ActivityEntry[];
  maxItems?: number;
}

const typeColors: Record<string, { bg: string; icon: string }> = {
  connected: { bg: "bg-emerald-500", icon: "text-white" },
  disconnected: { bg: "bg-red-500", icon: "text-white" },
  synced: { bg: "bg-sky-500", icon: "text-white" },
  refreshed: { bg: "bg-brand-500", icon: "text-white" },
  error: { bg: "bg-red-500", icon: "text-white" },
  configured: { bg: "bg-amber-500", icon: "text-white" },
};

export const ActivityTimeline: React.FC<ActivityTimelineProps> = ({ activities, maxItems = 10 }) => {
  if (activities.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-100 dark:bg-zinc-800">
          <svg className="h-6 w-6 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
        </div>
        <p className="text-xs font-medium text-zinc-400 dark:text-zinc-500">
          No recent activity
        </p>
      </div>
    );
  }

  const displayActivities = activities.slice(0, maxItems);

  // Group by date
  const today = new Date().toDateString();
  const groups: { date: string; label: string; activities: typeof displayActivities }[] = [];

  displayActivities.forEach((activity) => {
    const activityDate = new Date(activity.createdAt).toDateString();
    const existingGroup = groups.find((g) => g.date === activityDate);

    if (existingGroup) {
      existingGroup.activities.push(activity);
    } else {
      groups.push({
        date: activityDate,
        label: activityDate === today ? "Today" : new Date(activity.createdAt).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }),
        activities: [activity],
      });
    }
  });

  return (
    <div className="space-y-5">
      {groups.map((group, groupIndex) => (
        <div key={group.date}>
          <h4 className="mb-3 text-[10px] font-bold text-zinc-400 uppercase tracking-wider dark:text-zinc-500">
            {group.label}
          </h4>
          <div className="space-y-3">
            {group.activities.map((activity, index) => {
              const dotColor = typeColors[activity.type]?.bg ?? "bg-zinc-400";
              const relativeTime = formatRelativeTime(activity.createdAt);
              const globalIndex = groupIndex * 10 + index;

              return (
                <motion.div
                  key={activity.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, delay: globalIndex * 0.04 }}
                  className="flex items-start gap-3"
                >
                  <div className="flex flex-col items-center">
                    <div
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${dotColor} ring-2 ring-zinc-100 dark:ring-zinc-800`}
                    >
                      <PlatformIcon platformId={activity.platformId} size={10} />
                    </div>
                  </div>
                  <div className="flex flex-1 items-start justify-between gap-2 pb-3">
                    <div className="flex flex-col">
                      <p className="text-xs font-semibold text-zinc-900 dark:text-white">
                        {activity.action}
                      </p>
                      {activity.details && (
                        <p className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-500">
                          {activity.details}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 text-[10px] font-medium text-zinc-400 dark:text-zinc-500">
                      {relativeTime}
                    </span>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};
