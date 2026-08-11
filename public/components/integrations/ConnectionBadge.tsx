"use client";

import React from "react";
import type { ConnectionStatus } from "@/lib/integrations/types";
import { CheckCircleIcon, Loader2Icon, AlertTriangleIcon, LockIcon, WifiOffIcon } from "@/components/dashboard/icons";

interface ConnectionBadgeProps {
  status: ConnectionStatus;
}

const statusConfig: Record<
  ConnectionStatus,
  { label: string; bg: string; text: string; icon: React.FC<{ size?: number; className?: string }> }
> = {
  "not-connected": {
    label: "Not Connected",
    bg: "bg-zinc-100 dark:bg-zinc-800",
    text: "text-zinc-500 dark:text-zinc-400",
    icon: WifiOffIcon,
  },
  connecting: {
    label: "Connecting",
    bg: "bg-amber-100/80 dark:bg-amber-950/60",
    text: "text-amber-700 dark:text-amber-300",
    icon: Loader2Icon,
  },
  connected: {
    label: "Connected",
    bg: "bg-emerald-100/80 dark:bg-emerald-950/60",
    text: "text-emerald-700 dark:text-emerald-300",
    icon: CheckCircleIcon,
  },
  syncing: {
    label: "Syncing",
    bg: "bg-sky-100/80 dark:bg-sky-950/60",
    text: "text-sky-700 dark:text-sky-300",
    icon: Loader2Icon,
  },
  error: {
    label: "Error",
    bg: "bg-red-100/80 dark:bg-red-950/60",
    text: "text-red-700 dark:text-red-300",
    icon: AlertTriangleIcon,
  },
  disconnecting: {
    label: "Disconnecting",
    bg: "bg-amber-100/80 dark:bg-amber-950/60",
    text: "text-amber-700 dark:text-amber-300",
    icon: Loader2Icon,
  },
  "token-expired": {
    label: "Token Expired",
    bg: "bg-orange-100/80 dark:bg-orange-950/60",
    text: "text-orange-700 dark:text-orange-300",
    icon: LockIcon,
  },
};

export const ConnectionBadge: React.FC<ConnectionBadgeProps> = ({ status }) => {
  const config = statusConfig[status];
  const Icon = config.icon;

  const isSpinning = status === "connecting" || status === "syncing" || status === "disconnecting";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${config.bg} ${config.text}`}
    >
      <Icon
        size={12}
        className={`h-3 w-3 ${isSpinning ? "animate-spin" : ""}`}
      />
      {config.label}
    </span>
  );
};
