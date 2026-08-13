"use client";

import React from "react";
import { Check, Bot, Wrench, Clock } from "lucide-react";
import type { FeatureStatus } from "@/lib/features/featureCatalog";

interface FeatureBadgeConfig {
  label: string;
  classes: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

const STATUS_CONFIG: Record<FeatureStatus, FeatureBadgeConfig> = {
  supported: {
    label: "Supported",
    classes: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
    icon: Check,
  },
  "requires-bot": {
    label: "Requires Bot",
    classes: "bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
    icon: Bot,
  },
  "requires-setup": {
    label: "Requires Setup",
    classes: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
    icon: Wrench,
  },
  "coming-soon": {
    label: "Coming Soon",
    classes: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
    icon: Clock,
  },
};

interface FeatureBadgeProps {
  status: FeatureStatus;
}

export const FeatureBadge: React.FC<FeatureBadgeProps> = ({ status }) => {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${config.classes}`}>
      <Icon size={10} className="h-2.5 w-2.5" />
      {config.label}
    </span>
  );
};
