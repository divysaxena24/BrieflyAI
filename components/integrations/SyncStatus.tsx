"use client";

import React from "react";
import { RefreshCwIcon, AlertTriangleIcon } from "@/components/dashboard/icons";

interface SyncStatusProps {
  lastSync: string | null;
  status: "idle" | "syncing" | "error";
  error: string | null;
}

export const SyncStatus: React.FC<SyncStatusProps> = ({ lastSync, status, error }) => {
  if (status === "syncing") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-sky-600 dark:text-sky-400">
        <RefreshCwIcon size={12} className="h-3 w-3 animate-spin" />
        Syncing...
      </div>
    );
  }

  if (status === "error" && error) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
        <AlertTriangleIcon size={12} className="h-3 w-3" />
        {error}
      </div>
    );
  }

  if (!lastSync) {
    return (
      <span className="text-xs text-zinc-400 dark:text-zinc-500">
        Not synced yet
      </span>
    );
  }

  return (
    <span className="text-xs text-zinc-400 dark:text-zinc-500">
      Last synced {lastSync}
    </span>
  );
};
