"use client";

import React from "react";
import Link from "next/link";
import { useIntegrationStatus } from "@/lib/integrations/store";
import { useConfirmAction } from "@/components/ConfirmationDialog";
import { ConnectionBadge, PlatformIcon } from "@/components/integrations";
import { SettingsCard } from "./SettingsCard";
import { SettingButton } from "./SettingButton";
import { useToast } from "./Toast";
import { CableIcon, ExternalLinkIcon } from "./icons";
import { formatRelativeTime } from "@/lib/utils/time";
import type { ConnectionStatus } from "@/lib/integrations/types";

/** Rows shown while integration status is loading. */
function IntegrationsSkeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex animate-pulse items-center gap-3 rounded-xl border border-zinc-200/80 p-3 dark:border-zinc-800/80">
          <div className="h-10 w-10 rounded-xl bg-zinc-200 dark:bg-zinc-800" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-28 rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="h-2.5 w-40 rounded bg-zinc-100 dark:bg-zinc-800/60" />
          </div>
        </div>
      ))}
    </div>
  );
}

const CONNECTABLE: ConnectionStatus[] = ["connected", "syncing", "error", "token-expired", "needs-reconnect"];

/** Integrations: connection status, account, last sync, reconnect + disconnect. */
export function IntegrationsCard() {
  const { platforms, isLoading, connectPlatform, disconnectPlatform } = useIntegrationStatus();
  const confirmAction = useConfirmAction();
  const { show } = useToast();

  const handleDisconnect = async (id: string, name: string) => {
    const confirmed = await confirmAction({
      title: `Disconnect ${name}?`,
      message: (
        <>
          BrieflyAI will no longer be able to read your {name} data. You can reconnect at any time
          from this page.
        </>
      ),
      confirmLabel: "Disconnect",
      busyLabel: "Disconnecting…",
      onConfirm: () => disconnectPlatform(id),
    });
    if (confirmed) show("Integration disconnected");
  };

  return (
    <SettingsCard>
      {isLoading ? (
        <IntegrationsSkeleton />
      ) : (
        <div className="space-y-2">
          {platforms.map((platform) => {
            const connected = CONNECTABLE.includes(platform.status);
            const primaryActionLabel =
              platform.status === "not-connected" ? "Connect" : "Reconnect";
            return (
              <div
                key={platform.id}
                className="flex flex-col gap-3 rounded-xl border border-zinc-200/80 p-3.5 transition-colors hover:border-zinc-300 dark:border-zinc-800/80 dark:hover:border-zinc-700 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                    style={{ backgroundColor: `${platform.accentColor}18`, color: platform.accentColor }}
                  >
                    <PlatformIcon platformId={platform.id} size={20} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-bold text-zinc-900 dark:text-white">{platform.name}</p>
                      <ConnectionBadge status={platform.status} />
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                      {platform.account ? platform.account : platform.description}
                      {platform.lastSync && connected && (
                        <span className="text-zinc-400 dark:text-zinc-500">
                          {" "}
                          · Last synced {formatRelativeTime(platform.lastSync)}
                        </span>
                      )}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2 sm:pl-2">
                  <SettingButton variant="secondary" onClick={() => connectPlatform(platform.id)}>
                    <CableIcon size={13} className="h-3.5 w-3.5" />
                    {primaryActionLabel}
                  </SettingButton>
                  {connected && (
                    <SettingButton variant="dangerOutline" onClick={() => void handleDisconnect(platform.id, platform.name)}>
                      Disconnect
                    </SettingButton>
                  )}
                  <Link
                    href={`/dashboard/integrations/${platform.id}`}
                    className="inline-flex items-center justify-center rounded-xl p-2 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                    aria-label={`${platform.name} details`}
                  >
                    <ExternalLinkIcon size={14} className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SettingsCard>
  );
}
