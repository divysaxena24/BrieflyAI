"use client";

import dynamic from "next/dynamic";
import React, { useState, useEffect } from "react";
import { PageHeader } from "@/components/dashboard";
import { IntegrationGrid } from "@/components/integrations";
import { integrationPlatforms } from "@/lib/integrations/config";
import { AiSparklesIcon } from "@/components/dashboard/icons";
import { IntegrationGridSkeleton } from "@/components/integrations";
import { useIntegrationStatus } from "@/lib/integrations/store";

const IntegrationOverview = dynamic(
  () =>
    import("@/components/integrations").then((mod) => mod.IntegrationOverview),
  {
    ssr: false,
    loading: () => <IntegrationGridSkeleton count={6} />,
  }
);

export default function IntegrationsPage() {
  const { platforms, isLoading } = useIntegrationStatus();

  const [activities, setActivities] = useState<any[] | undefined>(undefined);
  useEffect(() => {
    fetch("/api/activity")
      .then((res) => res.ok ? res.json() : null)
      .then((body) => {
        if (body?.data && Array.isArray(body.data)) {
          setActivities(body.data);
        }
      })
      .catch(() => {});
  }, []);

  const connectedCount = platforms.filter(
    (p) => p.status === "connected" || p.status === "syncing"
  ).length;

  return (
    <div>
      <PageHeader
        title="Integrations"
        description="Connect and manage every data source powering BrieflyAI."
        badge={`${connectedCount} / ${platforms.length} Connected`}
        action={
          <span className="inline-flex items-center gap-2 rounded-xl bg-zinc-100 px-3.5 py-2 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            <AiSparklesIcon size={14} className="h-3.5 w-3.5 text-brand-600 dark:text-brand-400" />
            {platforms.length} platforms available
          </span>
        }
        aiReady={connectedCount >= 2}
        lastSync="2 min ago"
        platformsAvailable={connectedCount}
      />

      <IntegrationOverview
        platforms={isLoading ? integrationPlatforms : platforms}
        activities={activities}
      />

      <IntegrationGrid integrations={isLoading ? integrationPlatforms : platforms} />
    </div>
  );
}
