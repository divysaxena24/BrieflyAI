"use client";

import React from "react";
import type { IntegrationConfig } from "@/lib/integrations/types";

interface PlatformHealthProps {
  platforms: IntegrationConfig[];
}

const statusColors: Record<string, { dot: string; pulse: string; latency: string }> = {
  "connected": {
    dot: "bg-emerald-500",
    pulse: "bg-emerald-500",
    latency: "text-emerald-600 dark:text-emerald-400",
  },
  "syncing": {
    dot: "bg-sky-500",
    pulse: "bg-sky-500",
    latency: "text-sky-600 dark:text-sky-400",
  },
  "not-connected": {
    dot: "bg-zinc-300 dark:bg-zinc-600",
    pulse: "bg-zinc-300 dark:bg-zinc-600",
    latency: "text-zinc-400 dark:text-zinc-500",
  },
  "error": {
    dot: "bg-red-500",
    pulse: "bg-red-500",
    latency: "text-red-600 dark:text-red-400",
  },
  "token-expired": {
    dot: "bg-orange-500",
    pulse: "bg-orange-500",
    latency: "text-orange-600 dark:text-orange-400",
  },
  "needs-reconnect": {
    dot: "bg-orange-500",
    pulse: "bg-orange-500",
    latency: "text-orange-600 dark:text-orange-400",
  },
};

export const PlatformHealth: React.FC<PlatformHealthProps> = ({ platforms }) => {
  const activePlatforms = platforms.filter(
    (p) => p.status === "connected" || p.status === "syncing" || p.status === "error" || p.status === "token-expired" || p.status === "needs-reconnect"
  );

  return (
    <div className="flex flex-wrap items-center gap-4">
      {activePlatforms.map((platform) => {
        const colors = statusColors[platform.status] || statusColors["not-connected"];
        const isSyncing = platform.status === "syncing";
        const isHealthy = platform.status === "connected";

        return (
          <div key={platform.id} className="flex items-center gap-2.5">
            <div className="relative flex items-center justify-center">
              {isHealthy && (
                <span
                  className={`absolute h-3 w-3 rounded-full ${colors.pulse} opacity-75 pulse-ring`}
                />
              )}
              <span
                className={`relative h-2.5 w-2.5 rounded-full ${colors.dot} ring-2 ring-white dark:ring-zinc-900`}
              />
            </div>
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-zinc-900 dark:text-white">
                {platform.name}
              </span>
              <span className={`text-[10px] font-medium ${colors.latency}`}>
                {platform.status === "connected" ? "Healthy" : platform.status === "syncing" ? "Syncing..." : platform.status === "error" ? "Error" : "Needs attention"}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
