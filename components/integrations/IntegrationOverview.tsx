"use client";

import React, { useMemo } from "react";
import { motion } from "framer-motion";
import type { IntegrationConfig } from "@/lib/integrations/types";
import { integrationPlatforms, mcpToolsByPlatform } from "@/lib/integrations/config";
import { StatsGrid } from "./StatsGrid";
import { OverviewCard } from "./OverviewCard";
import { ProgressCard } from "./ProgressCard";
import { HealthIndicator } from "./HealthIndicator";
import { ActivityTimeline } from "./ActivityTimeline";
import {
  PlatformLinkIcon,
  RefreshCwIcon,
  ActivityStreamIcon,
  LayersIcon,
  CpuIcon,
  ListChecksIcon,
  CheckCircleIcon,
  AlertTriangleIcon,
  AiSparklesIcon,
  ArrowRightIcon,
} from "@/components/dashboard/icons";
import { QuickStats } from "./QuickStats";
import { AiReadinessIndicator } from "./AiReadinessIndicator";
import { PlatformHealth } from "./PlatformHealth";

// ──────────────────────────────────────────────
//  Compute derived stats from platform config
// ──────────────────────────────────────────────

function computeOverviewStats(platforms: IntegrationConfig[]) {
  const total = platforms.length;
  const connected = platforms.filter(
    (p) => p.status === "connected" || p.status === "syncing"
  ).length;
  const notConnected = platforms.filter((p) => p.status === "not-connected").length;
  const healthy = platforms.filter((p) => p.status === "connected").length;
  const warning = platforms.filter(
    (p) =>
      p.status === "syncing" ||
      p.status === "token-expired" ||
      p.status === "needs-reconnect"
  ).length;
  const disconnected = notConnected;
  const errorCount = platforms.filter(
    (p) => p.status === "error"
  ).length;

  let totalMcpTools = 0;
  const mcpBreakdown: { id: string; name: string; count: number }[] = [];
  for (const platform of platforms) {
    const tools = mcpToolsByPlatform[platform.id];
    if (tools) {
      totalMcpTools += tools.length;
      mcpBreakdown.push({ id: platform.id, name: platform.name, count: tools.length });
    }
  }

  const connectedPlatforms = platforms.filter(
    (p) => p.status === "connected"
  );
  const aiReady = connectedPlatforms.length >= 2;

  return {
    total,
    connected,
    notConnected,
    disconnected,
    connectedPercent: total > 0 ? Math.round((connected / total) * 100) : 0,
    healthy,
    warning,
    errorCount,
    totalMcpTools,
    mcpBreakdown,
    aiReady,
    connectedDataSources: connectedPlatforms.length,
  };
}

// ──────────────────────────────────────────────
//  Component
// ──────────────────────────────────────────────

interface IntegrationOverviewProps {
  platforms?: IntegrationConfig[];
  /** Activity data from /api/activity. Falls back to empty state when undefined/null. */
  activities?: Array<{
    id: string;
    platformId: string;
    action: string;
    details?: string | null;
    type: string;
    createdAt: string;
  }> | null;
}

export const IntegrationOverview: React.FC<IntegrationOverviewProps> = ({
  platforms = integrationPlatforms,
  activities,
}) => {
  const safeActivities = activities ?? [];
  const stats = useMemo(() => computeOverviewStats(platforms), [platforms]);

  const isEmpty = stats.connected === 0;

  if (isEmpty) {
    return (
      <section className="mb-8">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-zinc-200 bg-white p-10 text-center dark:border-zinc-700 dark:bg-zinc-900/90"
        >
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-zinc-100 dark:bg-zinc-800">
            <PlatformLinkIcon size={28} className="h-7 w-7 text-zinc-400 dark:text-zinc-500" />
          </div>
          <h3 className="text-lg font-bold text-zinc-900 dark:text-white">
            No integrations connected yet
          </h3>
          <p className="mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
            Connect your first platform to let BrieflyAI start monitoring and summarizing your messages.
          </p>
          <button
            type="button"
            className="mt-6 inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-5 py-2.5 text-xs font-bold text-white shadow-md shadow-brand-600/20 transition-all hover:bg-brand-500 active:scale-95"
          >
            Connect your first platform
            <ArrowRightIcon size={14} className="h-3.5 w-3.5" />
          </button>
        </motion.div>
      </section>
    );
  }

  return (
    <section className="mb-8 space-y-6">
      {/* ─── Compact Quick Stats Row ─── */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        <QuickStats
          stats={[
            {
              label: "Connected",
              value: `${stats.connected} / ${stats.total}`,
              accentColor: "#6366f1",
            },
            {
              label: "Sync",
              value: "2 min ago",
              icon: RefreshCwIcon,
            },
            {
              label: "MCP Tools",
              value: `${stats.totalMcpTools}`,
              icon: LayersIcon,
            },
            {
              label: "Health",
              value: stats.healthy === stats.total ? "Healthy" : `${stats.healthy} Healthy`,
              icon: ActivityStreamIcon,
              accentColor: "#10b981",
            },
            {
              label: "AI Ready",
              value: stats.aiReady ? "Yes" : "Limited",
              icon: CpuIcon,
              accentColor: stats.aiReady ? "#10b981" : "#f59e0b",
            },
            {
              label: "Activity",
              value: `${safeActivities.length} today`,
              icon: ListChecksIcon,
            },
          ]}
        />
      </motion.div>

      {/* ─── Main Dashboard Grid ─── */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* AI Readiness + Platform Health - Left 2 cols */}
        <div className="lg:col-span-2 space-y-6">
          {/* AI Readiness */}
          <AiReadinessIndicator
            score={stats.connectedPercent}
            connectedSources={stats.connectedDataSources}
            totalSources={stats.total}
            totalMcpTools={stats.totalMcpTools}
            status={stats.aiReady ? "ready" : "limited"}
          />

          {/* Platform Health */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
            className="flex flex-col rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md dark:border-zinc-800/80 dark:bg-zinc-900/90"
          >
            <h3 className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-4">
              Platform Health
            </h3>
            <PlatformHealth platforms={platforms} />
          </motion.div>
        </div>

        {/* Recent Activity - Right 1 col */}
        <div className="lg:col-span-1">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.2 }}
            className="flex h-full flex-col rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md dark:border-zinc-800/80 dark:bg-zinc-900/90"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
                Recent Activity
              </h3>
              <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500">
                {safeActivities.length} events
              </span>
            </div>
            <div className="flex-1 overflow-y-auto max-h-[320px] scrollbar-thin">
              <ActivityTimeline activities={safeActivities} maxItems={15} />
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
};
