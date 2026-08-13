"use client";

import React from "react";
import { motion } from "framer-motion";

interface QuickStat {
  label: string;
  value: string;
  icon?: React.FC<{ size?: number; className?: string }>;
  accentColor?: string;
}

interface QuickStatsProps {
  stats: QuickStat[];
}

export const QuickStats: React.FC<QuickStatsProps> = ({ stats }) => {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0 },
        visible: {
          opacity: 1,
          transition: {
            staggerChildren: 0.05,
          },
        },
      }}
      initial="hidden"
      animate="visible"
      className="mb-8 flex flex-wrap items-center gap-3"
    >
      {stats.map((stat) => (
        <motion.div
          key={stat.label}
          variants={{
            hidden: { opacity: 0, y: 8 },
            visible: { opacity: 1, y: 0 },
          }}
          className="group flex items-center gap-3 rounded-xl border border-zinc-200/80 bg-white px-4 py-2.5 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md dark:border-zinc-800/80 dark:bg-zinc-900/90"
        >
          {stat.icon && (
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
              style={{
                backgroundColor: stat.accentColor ? `${stat.accentColor}18` : undefined,
                color: stat.accentColor,
              }}
            >
              {stat.accentColor ? (
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: stat.accentColor }}
                />
              ) : (
                <stat.icon size={16} className="h-4 w-4" />
              )}
            </div>
          )}
          <div className="flex flex-col">
            <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">
              {stat.label}
            </span>
            <span className="text-sm font-bold text-zinc-900 dark:text-white">
              {stat.value}
            </span>
          </div>
        </motion.div>
      ))}
    </motion.div>
  );
};
