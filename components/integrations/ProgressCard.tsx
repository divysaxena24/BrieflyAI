"use client";

import React from "react";
import { motion } from "framer-motion";
import { OverviewCard } from "./OverviewCard";

interface ProgressCardProps {
  icon: React.FC<{ size?: number; className?: string }>;
  title: string;
  stat: string | number;
  description: string;
  gradient: string;
  iconBg: string;
  iconColor: string;
  progress: number; // 0-100
  progressColor: string;
  progressLabel?: string;
}

export const ProgressCard: React.FC<ProgressCardProps> = ({
  icon,
  title,
  stat,
  description,
  gradient,
  iconBg,
  iconColor,
  progress,
  progressColor,
  progressLabel,
}) => {
  return (
    <OverviewCard
      icon={icon}
      title={title}
      stat={stat}
      description={description}
      gradient={gradient}
      iconBg={iconBg}
      iconColor={iconColor}
    >
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.8, delay: 0.2, ease: "easeOut" }}
              className={`rounded-full ${progressColor}`}
            />
          </div>
          {progressLabel && (
            <span className="ml-2 text-[11px] font-bold text-zinc-500 dark:text-zinc-400">
              {progressLabel}
            </span>
          )}
        </div>
      </div>
    </OverviewCard>
  );
};
