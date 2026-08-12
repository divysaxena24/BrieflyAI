"use client";

import React from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/dashboard";
import { PlatformIcon, ConnectionBadge, PermissionBadge } from "@/components/integrations";
import { integrationPlatforms, mcpToolsByPlatform } from "@/lib/integrations/config";
import { useIntegrationStatus } from "@/lib/integrations/store";
import {
  ArrowRightIcon,
  SettingsIcon,
  RefreshCwIcon,
  ExternalLinkIcon,
  AlertTriangleIcon,
  CheckCircleIcon,
  MailIcon,
  GlobeIcon,
} from "@/components/dashboard/icons";

export default function PlatformSettingsPage() {
  const params = useParams<{ platform: string }>();
  const platformId = params.platform;

  const { platforms, connectPlatform, disconnectPlatform } = useIntegrationStatus();

  // Use the live status from the store, falling back to static config
  const integration = platforms.find((p) => p.id === platformId) ?? integrationPlatforms.find((p) => p.id === platformId);
  const mcpTools = mcpToolsByPlatform[platformId] ?? [];

  const status = integration?.status ?? "not-connected";
  const isConnected = status === "connected" || status === "syncing";

  if (!integration) {
    return (
      <div>
        <PageHeader
          title="Platform Not Found"
          description="The integration you're looking for doesn't exist."
        />
        <div className="flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-zinc-200 p-12 text-center dark:border-zinc-700">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Unknown platform: <strong className="text-zinc-800 dark:text-zinc-200">{platformId}</strong>
          </p>
          <Link
            href="/dashboard/integrations"
            className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-xs font-bold text-white transition-all hover:bg-brand-500"
          >
            <ArrowRightIcon size={14} className="h-3.5 w-3.5 rotate-180" />
            Back to Integrations
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={integration.name}
        description={`Manage your ${integration.name} connection, permissions, and available MCP tools.`}
        action={
          <Link
            href="/dashboard/integrations"
            className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3.5 py-2 text-xs font-semibold text-zinc-600 transition-all hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
          >
            <ArrowRightIcon size={14} className="h-3.5 w-3.5 rotate-180" />
            All Integrations
          </Link>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ─── Main Column ─── */}
        <div className="space-y-6 lg:col-span-2">
          {/* Platform Information */}
          <section className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
            <div className="mb-5 flex items-center gap-3">
              <div
                className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-100 dark:bg-zinc-800"
                style={{ backgroundColor: `${integration.accentColor}18`, color: integration.accentColor }}
              >
                <PlatformIcon platformId={integration.id} size={24} />
              </div>
              <div>
                <h2 className="text-lg font-bold text-zinc-900 dark:text-white">{integration.name}</h2>
                <span className="text-xs font-medium text-zinc-400">{integration.category}</span>
              </div>
            </div>
            <p className="text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
              {integration.description}
            </p>

            <div className="mt-5 flex items-center gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
              <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">Auth Method:</span>
              <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {integration.authenticationType === "google-oauth"
                  ? "Google OAuth"
                  : integration.authenticationType === "oauth"
                    ? "OAuth"
                    : integration.authenticationType === "bot-token"
                      ? "Bot Token"
                      : "OAuth"}
              </span>
            </div>
          </section>

          {/* Connection Status & Account Info */}
          <section className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
            <h3 className="mb-4 text-sm font-bold text-zinc-900 dark:text-white">Connection Status</h3>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <ConnectionBadge status={status} />
                {isConnected && (
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    Last synced: {integration.lastSync ?? "Just now"}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isConnected ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-600 transition-all hover:bg-zinc-50 active:scale-95 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                  >
                    <RefreshCwIcon size={14} className="h-3.5 w-3.5" />
                    Sync Now
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => connectPlatform(platformId)}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-3.5 py-2 text-xs font-bold text-white shadow-sm transition-all hover:bg-brand-500 active:scale-95"
                  >
                    <ExternalLinkIcon size={14} className="h-3.5 w-3.5" />
                    Connect {integration.name}
                  </button>
                )}
                {isConnected && (
                  <button
                    type="button"
                    onClick={() => disconnectPlatform(platformId)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-600 transition-all hover:bg-red-50 active:scale-95 dark:border-red-900 dark:bg-zinc-800 dark:text-red-400 dark:hover:bg-red-950/30"
                  >
                    Disconnect
                  </button>
                )}
              </div>
            </div>

            {/* Connected Account Details — only shown when connected */}
            {isConnected && (
              <div className="mt-5 space-y-3 rounded-xl bg-zinc-50 p-4 dark:bg-zinc-800/50">
                <h4 className="flex items-center gap-2 text-xs font-bold text-zinc-700 dark:text-zinc-300">
                  <CheckCircleIcon size={14} className="h-3.5 w-3.5 text-emerald-500" />
                  Connected Account
                </h4>

                <div className="grid grid-cols-[100px_1fr] gap-x-4 gap-y-2.5 text-xs">
                  {/* Email */}
                  <span className="font-medium text-zinc-400">Email</span>
                  <span className="flex items-center gap-1.5 font-semibold text-zinc-800 dark:text-zinc-200">
                    <MailIcon size={12} className="h-3 w-3 text-zinc-400" />
                    {integration.account ?? "Not available"}
                  </span>

                  {/* Provider */}
                  <span className="font-medium text-zinc-400">Provider</span>
                  <span className="flex items-center gap-1.5 font-medium text-zinc-700 dark:text-zinc-300">
                    <GlobeIcon size={12} className="h-3 w-3 text-zinc-400" />
                    {integration.authenticationType === "google-oauth" ? "Google" : integration.name}
                  </span>

                  {/* Permissions */}
                  <span className="font-medium text-zinc-400">Permissions</span>
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    <PermissionBadge level={integration.permissions} />
                  </span>

                  {/* Status */}
                  <span className="font-medium text-zinc-400">Status</span>
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    <ConnectionBadge status={status} />
                  </span>

                  {/* Scopes */}
                  {integration.scopes && (
                    <>
                      <span className="font-medium text-zinc-400">Scopes</span>
                      <span className="text-[10px] leading-relaxed text-zinc-500 dark:text-zinc-400 line-clamp-2">
                        {integration.scopes.split(" ").map((s) => s.split("/").pop() || s).join(", ")}
                      </span>
                    </>
                  )}

                  {/* Last Sync */}
                  <span className="font-medium text-zinc-400">Last Sync</span>
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    {integration.lastSync ?? "Just now"}
                  </span>
                </div>
              </div>
            )}
          </section>

          {/* Granted Permissions */}
          <section className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
            <h3 className="mb-4 text-sm font-bold text-zinc-900 dark:text-white">Granted Permissions</h3>
            <PermissionBadge level={integration.permissions} />
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              {integration.permissions === "read"
                ? `BrieflyAI can read your ${integration.name} data. No write or modification access is granted.`
                : integration.permissions === "write"
                  ? `BrieflyAI can read and write to your ${integration.name} data.`
                  : `BrieflyAI has full administrative access to your ${integration.name} account.`}
            </p>
          </section>

          {/* MCP Tools */}
          <section className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-bold text-zinc-900 dark:text-white">Available MCP Tools</h3>
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                {mcpTools.length} tools
              </span>
            </div>

            {mcpTools.length > 0 ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {mcpTools.map((tool) => (
                  <div
                    key={tool.id}
                    className="flex items-center gap-3 rounded-xl border border-zinc-100 bg-zinc-50/60 p-3.5 transition-colors hover:border-zinc-200 dark:border-zinc-800 dark:bg-zinc-800/40 dark:hover:border-zinc-700"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white shadow-sm dark:bg-zinc-800">
                      <SettingsIcon size={16} className="h-4 w-4 text-brand-600 dark:text-brand-400" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-zinc-900 dark:text-white">{tool.name}</p>
                      <p className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400 truncate">
                        {tool.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border-2 border-dashed border-zinc-200 p-6 text-center dark:border-zinc-700">
                <p className="text-xs text-zinc-400 dark:text-zinc-500">
                  No MCP tools available for {integration.name} yet.
                </p>
              </div>
            )}
          </section>
        </div>

        {/* ─── Sidebar Column ─── */}
        <div className="space-y-6">
          {/* Recent Sync History */}
          <section className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
            <h3 className="mb-4 text-sm font-bold text-zinc-900 dark:text-white">Sync History</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">Last Sync</span>
                <span className="text-xs font-medium text-zinc-700 dark:text-zinc-200">
                  {integration.lastSync ?? "—"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">Sync Status</span>
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircleIcon size={10} className="h-2.5 w-2.5" />
                  {isConnected ? "Active" : "Inactive"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">Sync Errors</span>
                <span className="text-xs font-medium text-zinc-400">None</span>
              </div>
            </div>
            <button
              type="button"
              className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-600 transition-all hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            >
              <RefreshCwIcon size={14} className="h-3.5 w-3.5" />
              Trigger Full Sync
            </button>
          </section>

          {/* Danger Zone */}
          <section className="rounded-2xl border border-red-200/80 bg-white p-6 shadow-sm dark:border-red-900/50 dark:bg-zinc-900/90">
            <div className="mb-4 flex items-center gap-2">
              <AlertTriangleIcon size={16} className="h-4 w-4 text-red-600 dark:text-red-400" />
              <h3 className="text-sm font-bold text-red-600 dark:text-red-400">Danger Zone</h3>
            </div>
            <p className="mb-4 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              Disconnecting will remove all synced data and stop AI monitoring. You can reconnect at any time.
            </p>
            <button
              type="button"
              onClick={() => disconnectPlatform(platformId)}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-red-200 bg-white px-4 py-2.5 text-xs font-bold text-red-600 transition-all hover:bg-red-50 active:scale-95 dark:border-red-900 dark:bg-zinc-800 dark:text-red-400 dark:hover:bg-red-950/30"
            >
              Disconnect {integration.name}
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
