"use client";

import React from "react";
import type { IntegrationError } from "@/lib/integrations/types";
import { AlertTriangleIcon, WifiOffIcon, LockIcon, PlugIcon, Loader2Icon } from "@/components/dashboard/icons";

interface ErrorStateProps {
  type: IntegrationError;
  message?: string;
  onRetry?: () => void;
}

const errorConfig: Record<
  IntegrationError,
  { title: string; description: string; icon: React.FC<{ size?: number; className?: string }>; color: string }
> = {
  "oauth-failure": {
    title: "OAuth Failed",
    description: "The authorization request was denied or failed. Please try connecting again.",
    icon: PlugIcon,
    color: "text-red-600 dark:text-red-400",
  },
  "connection-failed": {
    title: "Connection Failed",
    description: "Could not establish a connection to the platform. Check your network and try again.",
    icon: WifiOffIcon,
    color: "text-red-600 dark:text-red-400",
  },
  "permission-revoked": {
    title: "Permission Revoked",
    description: "Access permissions have been revoked. Re-connect to restore functionality.",
    icon: LockIcon,
    color: "text-orange-600 dark:text-orange-400",
  },
  "network-error": {
    title: "Network Error",
    description: "A network error occurred. Check your internet connection and try again.",
    icon: WifiOffIcon,
    color: "text-red-600 dark:text-red-400",
  },
  "token-expired": {
    title: "Token Expired",
    description: "Your access token has expired. Please re-authenticate to continue.",
    icon: LockIcon,
    color: "text-orange-600 dark:text-orange-400",
  },
};

export const ErrorState: React.FC<ErrorStateProps> = ({ type, message, onRetry }) => {
  const config = errorConfig[type];
  const Icon = config.icon;

  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-red-200/80 bg-red-50/50 p-6 text-center dark:border-red-900/50 dark:bg-red-950/20">
      <div className={`flex h-12 w-12 items-center justify-center rounded-xl bg-red-100 dark:bg-red-950/50 ${config.color}`}>
        <Icon size={24} className="h-6 w-6" />
      </div>
      <div>
        <h4 className="text-sm font-bold text-zinc-900 dark:text-white">{config.title}</h4>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 max-w-sm">
          {message ?? config.description}
        </p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-xs font-bold text-white shadow-sm transition-all hover:bg-brand-500 active:scale-95"
        >
          <Loader2Icon size={14} className="h-3.5 w-3.5" />
          Retry Connection
        </button>
      )}
    </div>
  );
};
