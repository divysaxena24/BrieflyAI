"use client";

import React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { useIntegrationStatus } from "@/lib/integrations/store";
import { ConnectionBadge, PlatformIcon } from "@/components/integrations";
import { formatRelativeTime } from "@/lib/utils/time";
import { ArrowRightIcon, PlugIcon } from "@/components/dashboard/icons";

/**
 * Connected Integrations section: one clean horizontal card per platform with
 * icon, account, live status badge, last sync time, and a Configure/Connect
 * action. Disconnected platforms render as gray cards with a Connect button.
 */
export const IntegrationOverview: React.FC = () => {
  const { platforms, isLoading, connectPlatform } = useIntegrationStatus();

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex animate-pulse items-center gap-4 rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90"
          >
            <div className="h-11 w-11 shrink-0 rounded-xl bg-zinc-200 dark:bg-zinc-800" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-28 rounded-md bg-zinc-200 dark:bg-zinc-800" />
              <div className="h-3 w-40 rounded bg-zinc-100 dark:bg-zinc-800" />
            </div>
            <div className="h-8 w-24 rounded-xl bg-zinc-100 dark:bg-zinc-800" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {platforms.map((platform, index) => {
        const isConnected = platform.status === "connected" || platform.status === "syncing";
        return (
          <motion.div
            key={platform.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: index * 0.04 }}
            className={`flex flex-col gap-4 rounded-2xl border p-4 shadow-sm transition-all sm:flex-row sm:items-center ${
              isConnected
                ? "border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-900/90"
                : "border-zinc-100 bg-zinc-50/60 dark:border-zinc-800/50 dark:bg-zinc-900/50"
            }`}
          >
            {/* Icon */}
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white shadow-sm dark:bg-zinc-800">
              <PlatformIcon platformId={platform.id} size={22} className="h-6 w-6 text-zinc-700 dark:text-zinc-200" />
            </div>

            {/* Name + account */}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <h3 className="text-sm font-bold text-zinc-900 dark:text-white">
                  {platform.name}
                </h3>
                <ConnectionBadge status={platform.status} />
              </div>
              <p className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
                {platform.account
                  ? platform.account
                  : isConnected
                    ? "Connected"
                    : "Not connected"}
              </p>
            </div>

            {/* Last sync */}
            <div className="shrink-0 text-left sm:text-right">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                Last sync
              </p>
              <p className="mt-0.5 text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                {platform.lastSync ? formatRelativeTime(platform.lastSync) : "Never"}
              </p>
            </div>

            {/* Action */}
            {isConnected ? (
              <Link
                href="/dashboard/integrations"
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3.5 text-xs font-bold text-zinc-700 transition-all hover:border-zinc-300 hover:bg-zinc-50 active:scale-95 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-200 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
              >
                Configure
                <ArrowRightIcon size={13} className="h-3.5 w-3.5 text-zinc-400" />
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => connectPlatform(platform.id)}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-brand-600 px-3.5 text-xs font-bold text-white shadow-md shadow-brand-600/15 transition-all hover:bg-brand-500 active:scale-95 dark:bg-brand-500 dark:hover:bg-brand-400"
              >
                <PlugIcon size={13} className="h-3.5 w-3.5" />
                Connect
              </button>
            )}
          </motion.div>
        );
      })}
    </div>
  );
};
