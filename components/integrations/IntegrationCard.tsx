"use client";

import React, { useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import type { IntegrationConfig } from "@/lib/integrations/types";
import { mcpToolsByPlatform } from "@/lib/integrations/config";
import { PlatformIcon } from "./PlatformIcon";
import { ConnectionBadge } from "./ConnectionBadge";
import { SyncStatus } from "./SyncStatus";
import { ArrowRightIcon } from "@/components/dashboard/icons";

interface IntegrationCardProps {
  integration: IntegrationConfig;
  index?: number;
}

export const IntegrationCard: React.FC<IntegrationCardProps> = ({
  integration,
  index = 0,
}) => {
  const { id, name, description, category, accentColor, permissions, lastSync, account, status } = integration;
  const [isHovered, setIsHovered] = useState(false);

  const mcpTools = mcpToolsByPlatform[id] || [];
  const toolCount = mcpTools.length;
  const isConnected = status === "connected" || status === "syncing";
  const statusLabel = isConnected ? "Connected" : "Not Connected";

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.05 }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-premium-lg dark:border-zinc-800/80 dark:bg-zinc-900/90"
    >
      {/* Top accent bar */}
      <div
        className="absolute inset-x-0 top-0 h-1 opacity-70 dark:opacity-50 transition-all duration-300"
        style={{ backgroundColor: accentColor }}
      />

      {/* Animated border glow on hover */}
      <div
        className="absolute inset-0 rounded-2xl opacity-0 transition-opacity duration-500 group-hover:opacity-100"
        style={{
          boxShadow: `0 0 0 1px ${accentColor}40, 0 0 20px ${accentColor}20`,
          pointerEvents: "none",
        }}
      />

      <div>
        {/* Header: Icon, name, category + status */}
        <div className="mb-4 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-3">
            <motion.div
              animate={{ scale: isHovered ? 1.08 : 1 }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-white shadow-lg"
              style={{ backgroundColor: accentColor }}
            >
              <PlatformIcon platformId={id} size={24} />
            </motion.div>
            <div className="min-w-0">
              <h3 className="truncate text-base font-bold text-zinc-900 dark:text-white">
                {name}
              </h3>
              <span className="block truncate text-xs font-medium text-zinc-400">
                {category}
              </span>
            </div>
          </div>
          <ConnectionBadge status={status} />
        </div>

        {/* Description */}
        <p className="mb-4 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400 line-clamp-2">
          {description}
        </p>

        {/* Meta row */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-100 px-2.5 py-1 text-[10px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: isConnected ? "#10b981" : "#a1a1aa" }}
            />
            {statusLabel}
          </span>
          <SyncStatus lastSync={isConnected ? (lastSync || "Just now") : lastSync} status="idle" error={null} />
          {toolCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-lg bg-violet-50 px-2.5 py-1 text-[10px] font-bold text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
              {toolCount} tools
            </span>
          )}
        </div>
      </div>

      {/* Footer: Open only */}
      <div className="mt-5 flex items-center justify-end border-t border-zinc-100 pt-4 dark:border-zinc-800">
        <Link
          href={`/dashboard/integrations/${id}`}
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 py-1.5 text-xs font-bold text-white transition-all duration-200 hover:bg-zinc-800 active:scale-95 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
        >
          Open
          <ArrowRightIcon size={12} className="h-3.5 w-3.5" />
        </Link>
      </div>
    </motion.div>
  );
};
