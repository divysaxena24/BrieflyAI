"use client";

import React from "react";
import { motion } from "framer-motion";

type HealthLevel = "healthy" | "warning" | "disconnected" | "error";

interface HealthIndicatorProps {
  level: HealthLevel;
  label: string;
  count?: number;
}

const healthColor: Record<HealthLevel, { dot: string; bg: string; text: string }> = {
  healthy: {
    dot: "bg-emerald-500",
    bg: "bg-emerald-50 dark:bg-emerald-950/30",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  warning: {
    dot: "bg-amber-500",
    bg: "bg-amber-50 dark:bg-amber-950/30",
    text: "text-amber-700 dark:text-amber-300",
  },
  disconnected: {
    dot: "bg-zinc-400",
    bg: "bg-zinc-50 dark:bg-zinc-800/50",
    text: "text-zinc-500 dark:text-zinc-400",
  },
  error: {
    dot: "bg-red-500",
    bg: "bg-red-50 dark:bg-red-950/30",
    text: "text-red-700 dark:text-red-300",
  },
};

export const HealthIndicator: React.FC<HealthIndicatorProps> = ({ level, label, count }) => {
  const colors = healthColor[level];

  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25 }}
      className={`inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 ${colors.bg}`}
    >
      <span className={`h-2 w-2 rounded-full ${colors.dot} shadow-sm`} />
      <span className={`text-xs font-semibold ${colors.text}`}>
        {label}
      </span>
      {count !== undefined && (
        <span className={`ml-auto text-xs font-black ${colors.text}`}>
          {count}
        </span>
      )}
    </motion.div>
  );
};
