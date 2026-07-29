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
    (p) => p.status === "syncing" || p.status === "token-expired"
  ).length;
  const disconnected = notConnected;
  const errorCount = platforms.filter(
    (p) => p.status === "error"
  ).length;

  // Total MCP tools across connected platforms
  let totalMcpTools = 0;
  const mcpBreakdown: { id: string; name: string; count: number }[] = [];
  for (const platform of platforms) {
    const tools = mcpToolsByPlatform[platform.id];
    if (tools) {
      totalMcpTools += tools.length;
      mcpBreakdown.push({ id: platform.id, name: platform.name, count: tools.length });
    }
  }

  // AI Readiness: need at least 2 connected platforms with data sources
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
    <section className="mb-8">
      {/* ─── 6-Card Overview Grid ─── */}
      <StatsGrid>
        {/* 1. Connected Platforms */}
        <ProgressCard
          icon={PlatformLinkIcon}
          title="Connected Platforms"
          stat={`${stats.connected} / ${stats.total} Connected`}
          description={`${stats.notConnected} platforms not yet connected`}
          gradient=""
          iconBg="bg-brand-50 dark:bg-brand-950/40"
          iconColor="text-brand-600 dark:text-brand-400"
          progress={stats.connectedPercent}
          progressColor="bg-brand-500"
          progressLabel={`${stats.connectedPercent}%`}
        />

        {/* 2. Last Synchronization */}
        <OverviewCard
          icon={RefreshCwIcon}
          title="Last Synchronization"
          stat="2 minutes ago"
          description="All active integrations synced successfully"
          gradient=""
          iconBg="bg-emerald-50 dark:bg-emerald-950/40"
          iconColor="text-emerald-600 dark:text-emerald-400"
        >
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100/80 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
            <CheckCircleIcon size={10} className="h-2.5 w-2.5" />
            Success
          </span>
        </OverviewCard>

        {/* 3. Platform Health */}
        <OverviewCard
          icon={ActivityStreamIcon}
          title="Platform Health"
          stat={
            stats.healthy === stats.total
              ? "All Healthy"
              : `${stats.healthy} Healthy`
          }
          description={`${stats.warning} need attention${stats.errorCount > 0 ? `, ${stats.errorCount} with errors` : ""}`}
          gradient=""
          iconBg="bg-sky-50 dark:bg-sky-950/40"
          iconColor="text-sky-600 dark:text-sky-400"
        >
          <div className="flex flex-wrap gap-1.5 mt-2">
            {stats.healthy > 0 && (
              <HealthIndicator level="healthy" label="Healthy" count={stats.healthy} />
            )}
            {stats.warning > 0 && (
              <HealthIndicator level="warning" label="Needs Attention" count={stats.warning} />
            )}
            {stats.errorCount > 0 && (
              <HealthIndicator level="error" label="Errors" count={stats.errorCount} />
            )}
          </div>
        </OverviewCard>

        {/* 4. Available MCP Tools */}
        <OverviewCard
          icon={LayersIcon}
          title="Available MCP Tools"
          stat={`${stats.totalMcpTools} Tools Available`}
          description="MCP tools across all platforms"
          gradient=""
          iconBg="bg-violet-50 dark:bg-violet-950/40"
          iconColor="text-violet-600 dark:text-violet-400"
        >
          {stats.mcpBreakdown.length > 0 && (
            <div className="mt-2 space-y-1">
              {stats.mcpBreakdown.slice(0, 4).map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between text-[10px]"
                >
                  <span className="font-medium text-zinc-500 dark:text-zinc-400">
                    {item.name}
                  </span>
                  <span className="font-bold text-zinc-700 dark:text-zinc-300">
                    {item.count}
                  </span>
                </div>
              ))}
              {stats.mcpBreakdown.length > 4 && (
                <p className="text-[10px] text-zinc-400 dark:text-zinc-500 text-center pt-0.5">
                  +{stats.mcpBreakdown.length - 4} more
                </p>
              )}
            </div>
          )}
        </OverviewCard>

        {/* 5. AI Readiness */}
        <OverviewCard
          icon={CpuIcon}
          title="AI Readiness"
          stat={stats.aiReady ? "Ready" : "Limited"}
          description={stats.aiReady ? `${stats.connectedDataSources} data sources connected` : `Connect at least 2 platforms to enable full AI features (${stats.connectedDataSources}/2)`}
          gradient={stats.aiReady ? "" : ""}
          iconBg={stats.aiReady ? "bg-emerald-50 dark:bg-emerald-950/40" : "bg-amber-50 dark:bg-amber-950/40"}
          iconColor={stats.aiReady ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}
        >
          <div className="mt-2 flex items-center gap-1.5">
            {stats.aiReady ? (
              <>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100/80 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                  <AiSparklesIcon size={10} className="h-2.5 w-2.5" />
                  AI Ready
                </span>
              </>
            ) : (
              <>
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100/80 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                  <AlertTriangleIcon size={10} className="h-2.5 w-2.5" />
                  Limited
                </span>
              </>
            )}
            <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
              {stats.connectedDataSources} / {stats.total} sources
            </span>
          </div>
        </OverviewCard>

        {/* 6. Recent Activity */}
        <OverviewCard
          icon={ListChecksIcon}
          title="Recent Activity"
          stat={`${safeActivities.length} events`}
          description="Latest integration activity"
          gradient=""
          iconBg="bg-indigo-50 dark:bg-indigo-950/40"
          iconColor="text-indigo-600 dark:text-indigo-400"
        >
          <div className="mt-2">
            <ActivityTimeline activities={safeActivities} />
          </div>
        </OverviewCard>
      </StatsGrid>
    </section>
  );
};
