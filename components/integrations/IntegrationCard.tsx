"use client";

import React from "react";
import Link from "next/link";
import type { IntegrationConfig } from "@/lib/integrations/types";
import { PlatformIcon } from "./PlatformIcon";
import { ConnectionBadge } from "./ConnectionBadge";
import { PermissionBadge } from "./PermissionBadge";
import { SyncStatus } from "./SyncStatus";
import { ArrowRightIcon } from "@/components/dashboard/icons";

interface IntegrationCardProps {
  integration: IntegrationConfig;
}

export const IntegrationCard: React.FC<IntegrationCardProps> = ({ integration }) => {
  const { id, name, description, category, accentColor, permissions, lastSync, account, status } = integration;

  return (
    <div className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md dark:border-zinc-800/80 dark:bg-zinc-900/90">
      {/* Top accent bar */}
      <div
        className="absolute inset-x-0 top-0 h-1 opacity-60 dark:opacity-40"
        style={{ backgroundColor: accentColor }}
      />

      <div>
        {/* Header: Icon, name, category + status */}
        <div className="mb-4 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div
              className="flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-100 text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-white"
              style={{ backgroundColor: `${accentColor}18`, color: accentColor }}
            >
              <PlatformIcon platformId={id} size={22} />
            </div>
            <div>
              <h3 className="text-base font-bold text-zinc-900 dark:text-white">
                {name}
              </h3>
              <span className="text-xs font-medium text-zinc-400">
                {category}
              </span>
            </div>
          </div>
          <ConnectionBadge status={status} />
        </div>

        {/* Description */}
        <p className="mb-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400 line-clamp-2">
          {description}
        </p>

        {/* Meta row: permission + sync + account */}
        <div className="flex flex-wrap items-center gap-2.5">
          <PermissionBadge level={permissions} />
          <SyncStatus lastSync={status === "connected" ? "Just now" : lastSync} status="idle" error={null} />
          {account && (
            <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500 truncate max-w-[140px]">
              {account}
            </span>
          )}
        </div>
      </div>

      {/* Footer: Details link only — Connect/Disconnect moved to Settings page */}
      <div className="mt-5 flex items-center justify-end border-t border-zinc-100 pt-4 dark:border-zinc-800">
        <Link
          href={`/dashboard/integrations/${id}`}
          className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3.5 py-2 text-xs font-semibold text-zinc-600 transition-all hover:bg-zinc-50 hover:text-zinc-900 active:scale-95 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700 dark:hover:text-white"
        >
          Details
          <ArrowRightIcon size={14} className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
};
