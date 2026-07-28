"use client";

import React from "react";
import type { IntegrationConfig } from "@/lib/integrations/types";
import { IntegrationCard } from "./IntegrationCard";
import { IntegrationGridSkeleton } from "./LoadingSkeleton";

interface IntegrationGridProps {
  integrations: IntegrationConfig[];
  isLoading?: boolean;
  emptyMessage?: string;
}

export const IntegrationGrid: React.FC<IntegrationGridProps> = ({
  integrations,
  isLoading = false,
  emptyMessage = "No integrations configured yet.",
}) => {
  if (isLoading) {
    return <IntegrationGridSkeleton count={8} />;
  }

  if (integrations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-zinc-200 p-12 text-center dark:border-zinc-700">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-zinc-100 dark:bg-zinc-800">
          <PlugIcon />
        </div>
        <h3 className="text-base font-bold text-zinc-900 dark:text-white">
          No integrations yet
        </h3>
        <p className="mt-1 max-w-xs text-xs text-zinc-500 dark:text-zinc-400">
          {emptyMessage}
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
      {integrations.map((integration) => (
        <IntegrationCard key={integration.id} integration={integration} />
      ))}
    </div>
  );
};

/** Simple plug icon for the empty state */
const PlugIcon: React.FC = () => (
  <svg
    className="h-8 w-8 text-zinc-400 dark:text-zinc-500"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={1.5}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M12 6v6m0 0v6m0-6h6m-6 0H6"
    />
  </svg>
);
