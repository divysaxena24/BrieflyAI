"use client";

import dynamic from "next/dynamic";
import React from "react";
import { PageHeader } from "@/components/dashboard";
import { IntegrationGrid } from "@/components/integrations";
import { integrationPlatforms } from "@/lib/integrations/config";
import { AiSparklesIcon } from "@/components/dashboard/icons";
import { IntegrationGridSkeleton } from "@/components/integrations";

// Dynamic import with ssr:false to prevent Framer Motion hydration mismatches
const IntegrationOverview = dynamic(
  () =>
    import("@/components/integrations").then((mod) => mod.IntegrationOverview),
  {
    ssr: false,
    loading: () => <IntegrationGridSkeleton count={6} />,
  }
);

export default function IntegrationsPage() {
  const connectedCount = integrationPlatforms.filter(
    (p) => p.status === "connected" || p.status === "syncing"
  ).length;

  return (
    <div>
      <PageHeader
        title="Integrations & Platforms"
        description="Connect your workspace apps to let BrieflyAI synthesize your communication streams."
        badge={`${connectedCount} Active`}
        action={
          <span className="inline-flex items-center gap-2 rounded-xl bg-zinc-100 px-3.5 py-2 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            <AiSparklesIcon size={14} className="h-3.5 w-3.5 text-brand-600 dark:text-brand-400" />
            {integrationPlatforms.length} platforms available
          </span>
        }
      />

      {/* ─── Integration Overview Dashboard (client-only to avoid Framer Motion hydration issues) ─── */}
      <IntegrationOverview platforms={integrationPlatforms} />

      <IntegrationGrid integrations={integrationPlatforms} />
    </div>
  );
}
