"use client";

import React, { useMemo } from "react";
import { motion } from "framer-motion";
import { useIntegrationStatus } from "@/lib/integrations/store";
import { useDashboardData } from "./useDashboardData";
import { supportedFeatureCount, featureCatalog } from "@/lib/features/featureCatalog";
import { formatRelativeTime } from "@/lib/utils/time";
import {
  ListChecksIcon,
  NetworkIcon,
  MessageIcon,
  ActivityStreamIcon,
} from "@/components/dashboard/icons";

/** A single premium overview stat card. */
interface OverviewCardData {
  key: string;
  icon: React.FC<{ size?: number; className?: string }>;
  iconBg: string;
  iconColor: string;
  value: string;
  label: string;
  subtitle: string;
}

/** Pulse skeleton shown while real data loads. */
const OverviewSkeleton: React.FC = () => (
  <div className="animate-pulse rounded-3xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
    <div className="mb-4 h-10 w-10 rounded-xl bg-zinc-200 dark:bg-zinc-800" />
    <div className="h-7 w-24 rounded-md bg-zinc-200 dark:bg-zinc-800" />
    <div className="mt-2 h-3 w-16 rounded bg-zinc-100 dark:bg-zinc-800" />
    <div className="mt-4 h-3 w-32 rounded bg-zinc-100 dark:bg-zinc-800" />
  </div>
);

/**
 * Four AI-first overview cards built from real data only:
 * features catalog, live integration status, and the activity/conversation APIs.
 */
export const OverviewCards: React.FC = () => {
  const { platforms, isLoading: integrationsLoading } = useIntegrationStatus();
  const { activities, conversations, loading: dataLoading } = useDashboardData();

  const connected = platforms.filter(
    (p) => p.status === "connected" || p.status === "syncing"
  ).length;

  // Queries this month: user messages across stored conversations in the current month.
  const queriesThisMonth = useMemo(() => {
    const now = new Date();
    return conversations.reduce((total, conversation) => {
      const count = conversation.messages.filter((message) => {
        if (message.role !== "user") return false;
        const createdAt = new Date(message.createdAt);
        return (
          createdAt.getFullYear() === now.getFullYear() &&
          createdAt.getMonth() === now.getMonth()
        );
      }).length;
      return total + count;
    }, 0);
  }, [conversations]);

  // Last AI activity: most recent activity log entry.
  const latestActivity = activities[0];

  const cards: OverviewCardData[] = [
    {
      key: "features",
      icon: ListChecksIcon,
      iconBg: "bg-violet-50 dark:bg-violet-950/40",
      iconColor: "text-violet-600 dark:text-violet-400",
      value: String(supportedFeatureCount()),
      label: "Supported Features",
      subtitle: `Across ${featureCatalog.length} integrations`,
    },
    {
      key: "integrations",
      icon: NetworkIcon,
      iconBg: "bg-emerald-50 dark:bg-emerald-950/40",
      iconColor: "text-emerald-600 dark:text-emerald-400",
      value: `${connected} / ${platforms.length}`,
      label: "Connected",
      subtitle: "Ready for AI queries",
    },
    {
      key: "conversations",
      icon: MessageIcon,
      iconBg: "bg-brand-50 dark:bg-brand-950/40",
      iconColor: "text-brand-600 dark:text-brand-400",
      value: String(queriesThisMonth),
      label: "Queries this month",
      subtitle: dataLoading ? "Loading…" : "Powered by Groq",
    },
    {
      key: "activity",
      icon: ActivityStreamIcon,
      iconBg: "bg-sky-50 dark:bg-sky-950/40",
      iconColor: "text-sky-600 dark:text-sky-400",
      value: latestActivity ? formatRelativeTime(latestActivity.createdAt) : "—",
      label: "Last AI Activity",
      subtitle: dataLoading
        ? "Loading…"
        : latestActivity
          ? latestActivity.action
          : "No activity yet",
    },
  ];

  if (integrationsLoading || dataLoading) {
    return (
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <OverviewSkeleton key={i} />
        ))}
      </div>
    );
  }

  return (
    <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card, index) => {
        const Icon = card.icon;
        return (
          <motion.div
            key={card.key}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: index * 0.05 }}
            className="group relative overflow-hidden rounded-3xl border border-zinc-200/80 bg-white p-6 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md dark:border-zinc-800/80 dark:bg-zinc-900/90"
          >
            <div className={`mb-4 flex h-10 w-10 items-center justify-center rounded-xl ${card.iconBg}`}>
              <Icon size={20} className={`h-5 w-5 ${card.iconColor}`} />
            </div>
            <p className="text-3xl font-black tracking-tight text-zinc-900 dark:text-white">
              {card.value}
            </p>
            <p className="mt-1 text-xs font-bold text-zinc-600 dark:text-zinc-300">
              {card.label}
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
              {card.subtitle}
            </p>
          </motion.div>
        );
      })}
    </div>
  );
};
