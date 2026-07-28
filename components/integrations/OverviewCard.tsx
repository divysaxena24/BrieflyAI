"use client";

import React from "react";
import { motion } from "framer-motion";

interface OverviewCardProps {
  icon: React.FC<{ size?: number; className?: string }>;
  title: string;
  stat: string | number;
  description: string;
  gradient: string;
  iconBg: string;
  iconColor: string;
  children?: React.ReactNode;
}

export const OverviewCard: React.FC<OverviewCardProps> = ({
  icon: Icon,
  title,
  stat,
  description,
  gradient,
  iconBg,
  iconColor,
  children,
}) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      whileHover={{ y: -3, scale: 1.01 }}
      className={`group relative overflow-hidden rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm transition-shadow duration-300 hover:shadow-md dark:border-zinc-800/80 dark:bg-zinc-900/90 ${gradient}`}
    >
      {/* Hover shine effect */}
      <div className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/5 to-transparent transition-transform duration-700 group-hover:translate-x-full" />

      <div className="relative z-10">
        <div className="mb-3 flex items-center justify-between">
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-xl ${iconBg} ${iconColor}`}
          >
            <Icon size={20} className="h-5 w-5" />
          </div>
        </div>

        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
          {title}
        </p>
        <p className="mt-0.5 text-2xl font-black tracking-tight text-zinc-900 dark:text-white">
          {stat}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
          {description}
        </p>

        {children && <div className="mt-3">{children}</div>}
      </div>
    </motion.div>
  );
};
