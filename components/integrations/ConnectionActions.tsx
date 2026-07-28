"use client";

import React from "react";
import Link from "next/link";
import type { ConnectionStatus } from "@/lib/integrations/types";
import { SettingsIcon, Loader2Icon } from "@/components/dashboard/icons";

interface ConnectionActionsProps {
  platformId: string;
  status: ConnectionStatus;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export const ConnectionActions: React.FC<ConnectionActionsProps> = ({
  platformId,
  status,
  onConnect,
  onDisconnect,
}) => {
  const isConnected = status === "connected" || status === "syncing";
  const isBusy = status === "connecting" || status === "syncing";

  const handlePrimaryClick = () => {
    if (isConnected) {
      onDisconnect?.();
    } else {
      onConnect?.();
    }
  };

  return (
    <div className="flex items-center gap-2">
      {/* Primary action: Connect or Disconnect */}
      <button
        type="button"
        onClick={handlePrimaryClick}
        disabled={isBusy}
        className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-bold transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none ${
          isConnected
            ? "border border-zinc-200 bg-white text-zinc-700 hover:bg-red-50 hover:text-red-600 hover:border-red-200 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-red-950/30 dark:hover:text-red-400 dark:hover:border-red-900"
            : "bg-brand-600 text-white shadow-sm shadow-brand-600/20 hover:bg-brand-500"
        }`}
      >
        {isBusy ? (          <>
          <Loader2Icon size={14} className="h-3.5 w-3.5 animate-spin" />
            {status === "syncing" ? "Syncing..." : "Connecting..."}
          </>
        ) : isConnected ? (
          "Disconnect"
        ) : (
          "Connect"
        )}
      </button>

      {/* Settings link */}
      <Link
        href={`/dashboard/integrations/${platformId}`}
        className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-600 transition-all hover:bg-zinc-50 hover:text-zinc-900 active:scale-95 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700 dark:hover:text-white"
      >
        <SettingsIcon size={14} className="h-3.5 w-3.5" />
        Settings
      </Link>
    </div>
  );
};
