"use client";

import React from "react";
import Link from "next/link";
import { AlertTriangleIcon, PlugIcon } from "@/components/dashboard/icons";
import { friendlyError, isReconnectError } from "./meta";
import type { IntegrationName } from "./types";

interface ErrorStateProps {
  /** Raw backend message (converted to friendly copy internally). */
  message?: string | null;
  /** Machine-readable error code. */
  code?: string | null;
  integration?: IntegrationName | null;
  /** Optional extra hint rendered under the message. */
  hint?: string;
}

/**
 * Friendly error state. Never exposes raw backend errors (codes, HTTP
 * statuses, `undefined`, `null`, stack traces). When the error means the
 * user must reconnect an integration, a "Reconnect integrations" CTA is shown.
 */
export function ErrorState({ message, code, integration, hint }: ErrorStateProps) {
  const friendly = friendlyError(message, code, integration);
  const reconnect = isReconnectError(code);

  return (
    <div className="flex flex-col gap-3 rounded-2xl rounded-bl-md border border-red-200 bg-red-50/70 p-4 dark:border-red-900/60 dark:bg-red-950/30">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-100 text-red-600 dark:bg-red-950/60 dark:text-red-400">
          <AlertTriangleIcon size={17} className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-bold text-red-800 dark:text-red-200">
            {reconnect ? "This integration needs to be reconnected" : "Couldn't complete that"}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-red-700/90 dark:text-red-300/90">
            {friendly}
          </p>
          {hint && (
            <p className="mt-1 text-[11px] leading-relaxed text-red-600/80 dark:text-red-400/80">{hint}</p>
          )}
        </div>
      </div>
      {reconnect && (
        <Link
          href="/dashboard/integrations"
          className="inline-flex w-fit items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-[11px] font-bold text-white shadow-sm transition-colors hover:bg-red-500"
        >
          <PlugIcon size={13} className="h-3.5 w-3.5" />
          Reconnect integrations
        </Link>
      )}
    </div>
  );
}
