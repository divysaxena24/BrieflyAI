"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ConnectionBadge, PermissionBadge, PlatformIcon } from "@/components/integrations";
import { integrationPlatforms, mcpToolsByPlatform } from "@/lib/integrations/config";
import { useIntegrationStatus } from "@/lib/integrations/store";
import { useConfirmAction } from "@/components/ConfirmationDialog";
import type { IntegrationConfig, McpTool, ConnectionStatus } from "@/lib/integrations/types";
import { formatRelativeTime } from "@/lib/utils/time";
import {
  ActivityStreamIcon,
  AiSparklesIcon,
  AlertTriangleIcon,
  ArrowRightIcon,
  BarChartIcon,
  CalendarIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ClockIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GaugeIcon,
  GlobeIcon,
  HardDriveIcon,
  InboxIcon,
  KeyIcon,
  Loader2Icon,
  LockIcon,
  MailIcon,
  MailOpenIcon,
  PlugIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  ShieldCheckIcon,
  ShieldIcon,
  SparklesIcon,
  TrendingUpIcon,
  UserProfileIcon,
  ZapIcon,
} from "@/components/dashboard/icons";

// ──────────────────────────────────────────────
//  Types & shared helpers
// ──────────────────────────────────────────────

type IconType = React.FC<{ size?: number; className?: string }>;

/** Homepage of each platform, used by Quick Actions → "Open …". */
const PLATFORM_HOMEPAGES: Record<string, string> = {
  gmail: "https://mail.google.com",
  "google-calendar": "https://calendar.google.com",
  "google-drive": "https://drive.google.com",
  github: "https://github.com",
  discord: "https://discord.com/app",
  telegram: "https://web.telegram.org",
};

/** OAuth connect route per OAuth platform (re-run consent from Quick Actions). */
const OAUTH_CONNECT_ROUTE: Record<string, string> = {
  gmail: "google-connect",
  "google-calendar": "google-connect",
  "google-drive": "google-connect",
  github: "github-connect",
  discord: "discord-connect",
};

/** Where a Google OAuth user manages app access. */
const GOOGLE_OAUTH_MANAGE_URL = "https://myaccount.google.com/permissions";

function authLabel(integration: IntegrationConfig): string {
  if (integration.authenticationType === "google-oauth") return "Google OAuth";
  if (integration.authenticationType === "oauth") return "OAuth 2.0";
  if (integration.authenticationType === "bot-token") return "Bot Token";
  return "OAuth";
}

function permissionLabel(level: string): string {
  if (level === "read") return "Read Only";
  if (level === "write") return "Read & Write";
  if (level === "admin") return "Full Access";
  return level;
}

function formatLastSync(lastSync: string | null | undefined, fallback = "Just now"): string {
  if (!lastSync) return fallback;
  const ts = Date.parse(lastSync);
  if (Number.isNaN(ts)) return lastSync;
  return formatRelativeTime(new Date(ts));
}

function shortScopes(scopes?: string | null): string {
  if (!scopes) return "";
  return scopes.split(" ").map((s) => s.split("/").pop() || s).join(", ");
}

// ──────────────────────────────────────────────
//  Deterministic demo content (per platform)
// ──────────────────────────────────────────────

interface TimelineItem {
  id: string;
  label: string;
  details: string;
  time: string;
  icon: IconType;
  tone: "emerald" | "brand" | "sky" | "violet";
}

const timelineTones: Record<TimelineItem["tone"], string> = {
  emerald: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400",
  brand: "bg-brand-50 text-brand-600 dark:bg-brand-950/40 dark:text-brand-400",
  sky: "bg-sky-50 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400",
  violet: "bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400",
};

function timelineFor(platform: IntegrationConfig): TimelineItem[] {
  if (platform.id === "gmail") {
    return [
      { id: "inbox", label: "Synced Inbox", details: "1,204 new messages", time: "2 min ago", icon: MailIcon, tone: "emerald" },
      { id: "labels", label: "Indexed Labels", details: "24 labels updated", time: "2 min ago", icon: SettingsIcon, tone: "brand" },
      { id: "threads", label: "Updated Threads", details: "312 threads refreshed", time: "3 min ago", icon: ActivityStreamIcon, tone: "sky" },
      { id: "attachments", label: "Processed Attachments", details: "48 files scanned", time: "4 min ago", icon: HardDriveIcon, tone: "violet" },
    ];
  }
  return [
    { id: "data", label: `Synced ${platform.name} data`, details: "Latest records pulled", time: "2 min ago", icon: ActivityStreamIcon, tone: "emerald" },
    { id: "meta", label: "Indexed Metadata", details: "Schema refreshed", time: "3 min ago", icon: DatabaseIcon, tone: "brand" },
    { id: "records", label: "Updated Records", details: "Changes merged", time: "4 min ago", icon: FileTextIcon, tone: "sky" },
  ];
}

interface PermissionItem {
  id: string;
  label: string;
  description: string;
  icon: IconType;
}

function permissionsFor(platform: IntegrationConfig): PermissionItem[] {
  switch (platform.id) {
    case "gmail":
      return [
        { id: "gmail-read", label: "Gmail Read", description: "Messages, labels, and inbox metadata", icon: MailIcon },
        { id: "calendar-read", label: "Calendar Read", description: "Events, reminders, and availability", icon: CalendarIcon },
        { id: "drive-meta", label: "Drive Metadata", description: "File names, owners, and sharing info", icon: HardDriveIcon },
        { id: "profile", label: "User Profile", description: "Name, email, and avatar", icon: UserProfileIcon },
      ];
    case "google-calendar":
      return [
        { id: "calendar-read", label: "Calendar Read", description: "Events, reminders, and availability", icon: CalendarIcon },
        { id: "profile", label: "User Profile", description: "Name, email, and avatar", icon: UserProfileIcon },
      ];
    case "google-drive":
      return [
        { id: "drive-read", label: "Drive Read", description: "Docs, sheets, and slides content", icon: HardDriveIcon },
        { id: "drive-meta", label: "Drive Metadata", description: "File names, owners, and sharing info", icon: FileTextIcon },
        { id: "profile", label: "User Profile", description: "Name, email, and avatar", icon: UserProfileIcon },
      ];
    default:
      return [
        { id: "read", label: `${platform.name} Read`, description: `Read ${platform.category.toLowerCase()} data`, icon: ShieldCheckIcon },
        { id: "profile", label: "User Profile", description: "Name and account details", icon: UserProfileIcon },
      ];
  }
}

interface UsageStat {
  label: string;
  value: string;
  sub: string;
  icon: IconType;
  tone: "sky" | "brand" | "violet" | "amber" | "emerald";
  bars: number[];
}

const usageTones: Record<UsageStat["tone"], { bg: string; text: string; bar: string }> = {
  sky: { bg: "bg-sky-50 dark:bg-sky-950/40", text: "text-sky-600 dark:text-sky-400", bar: "bg-sky-400" },
  brand: { bg: "bg-brand-50 dark:bg-brand-950/40", text: "text-brand-600 dark:text-brand-400", bar: "bg-brand-400" },
  violet: { bg: "bg-violet-50 dark:bg-violet-950/40", text: "text-violet-600 dark:text-violet-400", bar: "bg-violet-400" },
  amber: { bg: "bg-amber-50 dark:bg-amber-950/40", text: "text-amber-600 dark:text-amber-400", bar: "bg-amber-400" },
  emerald: { bg: "bg-emerald-50 dark:bg-emerald-950/40", text: "text-emerald-600 dark:text-emerald-400", bar: "bg-emerald-400" },
};

function usageFor(platform: IntegrationConfig): UsageStat[] {
  switch (platform.id) {
    case "gmail":
      return [
        { label: "Emails Indexed", value: "12,482", sub: "Last 7 days", icon: InboxIcon, tone: "sky", bars: [4, 6, 5, 9, 7, 10] },
        { label: "Queries Executed", value: "423", sub: "Last 7 days", icon: SearchIcon, tone: "brand", bars: [3, 5, 4, 7, 6, 8] },
        { label: "AI Summaries", value: "188", sub: "Generated with Groq", icon: SparklesIcon, tone: "violet", bars: [2, 4, 6, 5, 7, 9] },
        { label: "Storage Used", value: "124 MB", sub: "Across 3,210 threads", icon: HardDriveIcon, tone: "amber", bars: [5, 6, 6, 7, 8, 8] },
      ];
    case "google-calendar":
      return [
        { label: "Events Indexed", value: "1,204", sub: "Last 7 days", icon: CalendarIcon, tone: "sky", bars: [4, 5, 6, 6, 7, 8] },
        { label: "Queries Executed", value: "86", sub: "Last 7 days", icon: SearchIcon, tone: "brand", bars: [3, 4, 5, 4, 6, 7] },
        { label: "AI Summaries", value: "34", sub: "Generated with Groq", icon: SparklesIcon, tone: "violet", bars: [2, 3, 4, 5, 4, 6] },
        { label: "Storage Used", value: "8 MB", sub: "Metadata only", icon: HardDriveIcon, tone: "amber", bars: [3, 3, 4, 4, 5, 5] },
      ];
    default:
      return [
        { label: "Records Indexed", value: "8,214", sub: "Last 7 days", icon: DatabaseIcon, tone: "sky", bars: [4, 6, 5, 8, 7, 9] },
        { label: "Queries Executed", value: "312", sub: "Last 7 days", icon: SearchIcon, tone: "brand", bars: [3, 5, 4, 6, 5, 8] },
        { label: "AI Summaries", value: "96", sub: "Generated with Groq", icon: SparklesIcon, tone: "violet", bars: [2, 4, 5, 4, 6, 7] },
        { label: "Storage Used", value: "42 MB", sub: "Synced metadata", icon: HardDriveIcon, tone: "amber", bars: [4, 5, 5, 6, 6, 7] },
      ];
  }
}

function toolIcon(tool: McpTool): IconType {
  const name = tool.name.toLowerCase();
  const id = tool.id.toLowerCase();
  if (name.includes("search") || id.includes("search")) return SearchIcon;
  if (name.includes("send") || name.includes("reply")) return MailOpenIcon;
  if (name.includes("draft") || name.includes("compose") || name.includes("write")) return FileTextIcon;
  if (name.includes("read") && (name.includes("mail") || name.includes("email"))) return MailIcon;
  if (name.includes("event") || name.includes("calendar") || name.includes("schedule")) return CalendarIcon;
  if (name.includes("repositor") || name.includes("repo")) return DatabaseIcon;
  if (name.includes("file") || name.includes("document") || id.includes("gdrive")) return HardDriveIcon;
  if (name.includes("channel") || name.includes("chat") || name.includes("message") || name.includes("issue") || name.includes("pull") || name.includes("commit")) return ActivityStreamIcon;
  return SettingsIcon;
}

function toolStatus(tool: McpTool, platform: IntegrationConfig): { label: "Active" | "Disabled"; hint?: string } {
  const name = tool.name.toLowerCase();
  const needsWrite = ["send", "create", "write", "post", "comment", "update"].some((w) => name.includes(w));
  if (needsWrite && platform.permissions === "read") {
    return { label: "Disabled", hint: "Requires write permission" };
  }
  return { label: "Active" };
}

// ──────────────────────────────────────────────
//  Shared UI primitives
// ──────────────────────────────────────────────

const cardEnter = { opacity: 0, y: 16 };

function Card({
  id,
  className = "",
  delay = 0,
  children,
}: {
  id?: string;
  className?: string;
  delay?: number;
  children: React.ReactNode;
}) {
  return (
    <motion.section
      id={id}
      initial={cardEnter}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: "easeOut" }}
      className={`rounded-3xl border border-zinc-200/80 bg-white p-5 shadow-sm transition-all duration-300 hover:shadow-md sm:p-6 dark:border-zinc-800/80 dark:bg-zinc-900/90 ${className}`}
    >
      {children}
    </motion.section>
  );
}

function SectionHeader({
  icon: Icon,
  iconBg = "bg-zinc-100 dark:bg-zinc-800",
  iconColor = "text-zinc-600 dark:text-zinc-300",
  title,
  subtitle,
  action,
}: {
  icon: IconType;
  iconBg?: string;
  iconColor?: string;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${iconBg}`}>
          <Icon size={16} className={`h-4 w-4 ${iconColor}`} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-zinc-900 dark:text-white">{title}</h3>
          {subtitle && <p className="mt-0.5 truncate text-[11px] text-zinc-400 dark:text-zinc-500">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

function Chip({ icon: Icon, label, tone = "zinc" }: { icon: IconType; label: string; tone?: "emerald" | "brand" | "zinc" | "amber" }) {
  const tones = {
    emerald: "border-emerald-100 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300",
    brand: "border-brand-100 bg-brand-50 text-brand-700 dark:border-brand-900/50 dark:bg-brand-950/40 dark:text-brand-300",
    amber: "border-amber-100 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300",
    zinc: "border-zinc-200 bg-white text-zinc-600 dark:border-zinc-700/80 dark:bg-zinc-900 dark:text-zinc-300",
  };
  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-semibold shadow-sm ${tones[tone]}`}
    >
      <Icon size={12} className="h-3 w-3" />
      {label}
    </motion.span>
  );
}

function MiniBars({ heights, barClass }: { heights: number[]; barClass: string }) {
  return (
    <div className="flex items-end gap-[3px]" aria-hidden="true">
      {heights.map((h, i) => (
        <span
          key={i}
          className={`w-[3px] rounded-full ${i === heights.length - 1 ? barClass : "bg-zinc-200 dark:bg-zinc-700"}`}
          style={{ height: `${h * 2}px` }}
        />
      ))}
    </div>
  );
}

function OverviewRow({
  icon: Icon,
  label,
  value,
  muted,
}: {
  icon: IconType;
  label: string;
  value: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <span className="flex min-w-0 items-center gap-2.5 text-xs font-medium text-zinc-400 dark:text-zinc-500">
        <Icon size={13} className="h-3.5 w-3.5 shrink-0 text-zinc-300 dark:text-zinc-600" />
        {label}
      </span>
      <span className={`min-w-0 text-right text-xs font-semibold text-zinc-800 dark:text-zinc-200 ${muted ? "text-zinc-400 dark:text-zinc-500" : ""}`}>
        {value}
      </span>
    </div>
  );
}

// ──────────────────────────────────────────────
//  Hero
// ──────────────────────────────────────────────

function HeroHeader({
  integration,
  isSyncing,
  lastSync,
  onSync,
  onManagePermissions,
  onDisconnect,
}: {
  integration: IntegrationConfig;
  isSyncing: boolean;
  lastSync: string | null;
  onSync: () => void;
  onManagePermissions: () => void;
  onDisconnect: () => void;
}) {
  const accent = integration.accentColor;

  return (
    <motion.div initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}>
      <Link
        href="/dashboard/integrations"
        className="mb-6 inline-flex items-center gap-1.5 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-600 dark:hover:text-zinc-300"
      >
        <ArrowRightIcon size={13} className="h-3 w-3 rotate-180" />
        All Integrations
      </Link>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        {/* Identity */}
        <div className="flex min-w-0 items-start gap-4 sm:items-center">
          <div className="relative shrink-0">
            <div className="absolute -inset-1.5 rounded-2xl opacity-30 blur-lg" style={{ background: accent }} />
            <div
              className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-white/60 shadow-premium-lg"
              style={{ background: `linear-gradient(135deg, ${accent}24, ${accent}0a)`, color: accent }}
            >
              <PlatformIcon platformId={integration.id} size={26} />
            </div>
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-black tracking-tight text-zinc-900 sm:text-3xl dark:text-white">
                {integration.name}
              </h1>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                  isSyncing
                    ? "bg-amber-100/80 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"
                    : "bg-emerald-100/80 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
                }`}
              >
                <span className="relative flex h-1.5 w-1.5">
                  <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${isSyncing ? "animate-ping bg-amber-400" : "animate-ping bg-emerald-400"}`} />
                  <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${isSyncing ? "bg-amber-500" : "bg-emerald-500"}`} />
                </span>
                {isSyncing ? "Syncing" : "Connected"}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-100/80 px-2.5 py-1 text-[11px] font-bold text-brand-700 dark:bg-brand-950/50 dark:text-brand-300">
                <AiSparklesIcon size={12} className="h-3 w-3" />
                AI Ready
              </span>
            </div>

            <p className="mt-1.5 max-w-xl text-xs leading-relaxed text-zinc-500 sm:text-sm dark:text-zinc-400">
              {integration.description}
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400 dark:text-zinc-500">
              <span className="inline-flex items-center gap-1.5">
                <ClockIcon size={12} className="h-3 w-3" />
                Last synced <strong className="font-semibold text-zinc-600 dark:text-zinc-300">{formatLastSync(lastSync, "2 minutes ago")}</strong>
              </span>
              {integration.account && (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <MailIcon size={12} className="h-3 w-3 shrink-0" />
                  <span className="truncate">{integration.account}</span>
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={onSync}
            disabled={isSyncing}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-xs font-bold text-white shadow-md shadow-brand-600/20 transition-all hover:-translate-y-px hover:bg-brand-500 hover:shadow-lg hover:shadow-brand-600/25 active:translate-y-0 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-brand-500 dark:hover:bg-brand-400"
          >
            {isSyncing ? (
              <Loader2Icon size={14} className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon size={14} className="h-3.5 w-3.5" />
            )}
            {isSyncing ? "Syncing…" : "Sync Now"}
          </button>
          <button
            type="button"
            onClick={onManagePermissions}
            className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-xs font-semibold text-zinc-700 transition-all hover:border-zinc-300 hover:bg-zinc-50 active:scale-95 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:border-zinc-600 dark:hover:bg-zinc-700"
          >
            <ShieldCheckIcon size={14} className="h-3.5 w-3.5 text-brand-600 dark:text-brand-400" />
            Manage Permissions
          </button>
          <button
            type="button"
            onClick={onDisconnect}
            className="inline-flex items-center rounded-xl px-3.5 py-2.5 text-xs font-semibold text-zinc-400 transition-all hover:bg-red-50 hover:text-red-600 active:scale-95 dark:hover:bg-red-950/30 dark:hover:text-red-400"
          >
            Disconnect
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ──────────────────────────────────────────────
//  Status chips
// ──────────────────────────────────────────────

function StatusChips({
  integration,
  isConnected,
  isSyncing,
  lastSync,
  mcpCount,
}: {
  integration: IntegrationConfig;
  isConnected: boolean;
  isSyncing: boolean;
  lastSync: string | null;
  mcpCount: number;
}) {
  const chips: { icon: IconType; label: string; tone: "emerald" | "brand" | "zinc" | "amber" }[] = [
    {
      icon: CheckCircleIcon,
      label: isSyncing ? "Syncing…" : isConnected ? "Connected" : "Not Connected",
      tone: isSyncing ? "amber" : isConnected ? "emerald" : "zinc",
    },
    { icon: AiSparklesIcon, label: "AI Ready", tone: "brand" },
    { icon: LockIcon, label: permissionLabel(integration.permissions), tone: "zinc" },
    { icon: SettingsIcon, label: `${mcpCount} MCP Tools`, tone: "zinc" },
    { icon: ClockIcon, label: `Last Sync ${formatLastSync(lastSync)}`, tone: "zinc" },
    { icon: GlobeIcon, label: authLabel(integration), tone: "zinc" },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.08 }}
      className="mt-6 flex flex-wrap gap-2"
    >
      {chips.map((chip) => (
        <Chip key={chip.label} icon={chip.icon} label={chip.label} tone={chip.tone} />
      ))}
    </motion.div>
  );
}

// ──────────────────────────────────────────────
//  Left column — Connection Overview
// ──────────────────────────────────────────────

function ConnectionOverviewCard({
  integration,
  status,
  lastSync,
}: {
  integration: IntegrationConfig;
  status: ConnectionStatus;
  lastSync: string | null;
}) {
  const isGoogle = integration.authenticationType === "google-oauth";

  return (
    <Card id="overview">
      <SectionHeader
        icon={GlobeIcon}
        iconBg="bg-brand-50 dark:bg-brand-950/40"
        iconColor="text-brand-600 dark:text-brand-400"
        title="Connection Overview"
        subtitle="Everything about this connection"
        action={
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Healthy
          </span>
        }
      />

      <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
        <OverviewRow
          icon={MailIcon}
          label="Connected Account"
          value={integration.account ? (
            <span className="[overflow-wrap:anywhere]">{integration.account}</span>
          ) : (
            <span className="font-normal text-zinc-400 dark:text-zinc-500">Not available</span>
          )}
        />
        <OverviewRow
          icon={GlobeIcon}
          label="Provider"
          value={isGoogle ? "Google" : integration.name}
        />
        <OverviewRow icon={ShieldIcon} label="Permissions" value={<PermissionBadge level={integration.permissions} />} />
        <OverviewRow
          icon={ActivityStreamIcon}
          label="Connection Status"
          value={<ConnectionBadge status={status} />}
        />
        <OverviewRow
          icon={CalendarIcon}
          label="Created"
          value={
            integration.createdAt ? (
              formatRelativeTime(integration.createdAt)
            ) : (
              <span className="font-normal text-zinc-400 dark:text-zinc-500">—</span>
            )
          }
        />
        <OverviewRow icon={ClockIcon} label="Last Sync" value={formatLastSync(lastSync)} />
        {integration.scopes && (
          <OverviewRow
            icon={KeyIcon}
            label="Scopes"
            muted
            value={<span className="text-[10px] font-medium leading-relaxed [overflow-wrap:anywhere] line-clamp-2">{shortScopes(integration.scopes)}</span>}
          />
        )}
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────
//  Permissions
// ──────────────────────────────────────────────

function PermissionsSection({ integration }: { integration: IntegrationConfig }) {
  const permissions = permissionsFor(integration);

  return (
    <Card id="permissions" delay={0.05}>
      <SectionHeader
        icon={ShieldCheckIcon}
        iconBg="bg-emerald-50 dark:bg-emerald-950/40"
        iconColor="text-emerald-600 dark:text-emerald-400"
        title="Permissions"
        subtitle="Scopes granted to BrieflyAI"
        action={
          <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-[10px] font-bold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {permissions.length} granted
          </span>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {permissions.map((permission, index) => (
          <motion.div
            key={permission.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.1 + index * 0.05 }}
            className="group flex items-center gap-3 rounded-2xl border border-zinc-100 bg-zinc-50/60 p-3.5 transition-all duration-300 hover:-translate-y-0.5 hover:border-emerald-200 hover:bg-white hover:shadow-md dark:border-zinc-800 dark:bg-zinc-800/40 dark:hover:border-emerald-900/60 dark:hover:bg-zinc-800"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-zinc-500 shadow-sm transition-colors group-hover:text-emerald-600 dark:bg-zinc-800 dark:text-zinc-400 dark:group-hover:text-emerald-400">
              <permission.icon size={16} className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-bold text-zinc-900 dark:text-white">{permission.label}</p>
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-100/80 px-2 py-0.5 text-[9px] font-bold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                  <CheckCircleIcon size={9} className="h-2 w-2" />
                  Granted
                </span>
              </div>
              <p className="mt-0.5 truncate text-[10px] text-zinc-400 dark:text-zinc-500">{permission.description}</p>
            </div>
          </motion.div>
        ))}
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────
//  MCP Tools
// ──────────────────────────────────────────────

function McpToolsSection({ integration, tools }: { integration: IntegrationConfig; tools: McpTool[] }) {
  return (
    <Card id="mcp-tools" delay={0.1}>
      <SectionHeader
        icon={SettingsIcon}
        iconBg="bg-brand-50 dark:bg-brand-950/40"
        iconColor="text-brand-600 dark:text-brand-400"
        title="MCP Tools"
        subtitle="Available to the AI assistant"
        action={
          <span className="rounded-full bg-brand-50 px-2.5 py-1 text-[10px] font-bold text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
            {tools.length} tools
          </span>
        }
      />

      {tools.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {tools.map((tool, index) => {
            const Icon = toolIcon(tool);
            const status = toolStatus(tool, integration);
            const disabled = status.label === "Disabled";
            return (
              <motion.div
                key={tool.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: 0.12 + index * 0.05 }}
                whileHover={{ y: -3 }}
                className={`group relative flex items-start gap-3 overflow-hidden rounded-2xl border p-4 transition-all duration-300 ${
                  disabled
                    ? "border-zinc-100 bg-zinc-50/50 opacity-75 dark:border-zinc-800/60 dark:bg-zinc-800/30"
                    : "border-zinc-100 bg-white hover:border-brand-200 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-800/40 dark:hover:border-brand-900/60 dark:hover:shadow-black/30"
                }`}
              >
                {!disabled && (
                  <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand-400/50 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                )}
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-sm transition-all duration-300 ${
                    disabled
                      ? "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500"
                      : "bg-gradient-to-br from-brand-50 to-brand-100/60 text-brand-600 group-hover:scale-105 dark:from-brand-950/60 dark:to-brand-900/40 dark:text-brand-300"
                  }`}
                >
                  <Icon size={18} className="h-[18px] w-[18px]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-bold text-zinc-900 dark:text-white">{tool.name}</p>
                    <span
                      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold ${
                        disabled
                          ? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                          : "bg-emerald-100/80 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
                      }`}
                    >
                      <span className={`h-1 w-1 rounded-full ${disabled ? "bg-zinc-400" : "bg-emerald-500"}`} />
                      {status.label}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-zinc-400 dark:text-zinc-500">{tool.description}</p>
                  {status.hint && (
                    <p className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold text-amber-600 dark:bg-amber-950/40 dark:text-amber-400">
                      <LockIcon size={9} className="h-2 w-2" />
                      {status.hint}
                    </p>
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-2xl border-2 border-dashed border-zinc-200 p-6 text-center dark:border-zinc-700">
          <SettingsIcon size={20} className="mx-auto h-5 w-5 text-zinc-300 dark:text-zinc-600" />
          <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
            No MCP tools available for {integration.name} yet.
          </p>
        </div>
      )}
    </Card>
  );
}

// ──────────────────────────────────────────────
//  Recent Activity (timeline)
// ──────────────────────────────────────────────

function TimelineSection({
  integration,
  isSyncing,
  onSync,
}: {
  integration: IntegrationConfig;
  isSyncing: boolean;
  onSync: () => void;
}) {
  const items = timelineFor(integration);

  return (
    <Card id="activity" delay={0.15}>
      <SectionHeader
        icon={ActivityStreamIcon}
        iconBg="bg-sky-50 dark:bg-sky-950/40"
        iconColor="text-sky-600 dark:text-sky-400"
        title="Recent Activity"
        subtitle="Latest sync activity"
        action={
          <button
            type="button"
            onClick={onSync}
            disabled={isSyncing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-[10px] font-semibold text-zinc-500 transition-all hover:bg-zinc-50 hover:text-zinc-700 active:scale-95 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
          >
            <RefreshCwIcon size={11} className={`h-2.5 w-2.5 ${isSyncing ? "animate-spin" : ""}`} />
            {isSyncing ? "Syncing…" : "Sync now"}
          </button>
        }
      />

      <div className="space-y-0">
        {isSyncing && (
          <div className="flex gap-3">
            <div className="flex flex-col items-center">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400">
                <Loader2Icon size={12} className="h-3 w-3 animate-spin" />
              </div>
              <div className="w-px flex-1 bg-sky-200/70 dark:bg-sky-900" />
            </div>
            <div className="pb-3 pt-0.5">
              <p className="text-xs font-semibold text-sky-700 dark:text-sky-300">Syncing {integration.name}…</p>
              <p className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-500">Fetching the latest data</p>
            </div>
          </div>
        )}

        {items.map((item, index) => (
          <div key={item.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-4 ring-white dark:ring-zinc-900 ${timelineTones[item.tone]}`}>
                <item.icon size={12} className="h-3 w-3" />
              </div>
              {index < items.length - 1 && <div className="w-px flex-1 bg-zinc-100 dark:bg-zinc-800" />}
            </div>
            <div className="flex flex-1 items-start justify-between gap-3 pb-3 pt-0.5">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-zinc-900 dark:text-white">{item.label}</p>
                <p className="mt-0.5 truncate text-[10px] text-zinc-400 dark:text-zinc-500">{item.details}</p>
              </div>
              <span className="shrink-0 text-[10px] font-medium text-zinc-400 dark:text-zinc-500">{item.time}</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────
//  Usage Analytics
// ──────────────────────────────────────────────

function UsageAnalyticsSection({ integration }: { integration: IntegrationConfig }) {
  const stats = usageFor(integration);

  return (
    <Card id="usage" delay={0.2}>
      <SectionHeader
        icon={BarChartIcon}
        iconBg="bg-violet-50 dark:bg-violet-950/40"
        iconColor="text-violet-600 dark:text-violet-400"
        title="Usage Analytics"
        subtitle="How the AI assistant uses this connection"
        action={
          <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-[10px] font-bold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            Last 7 days
          </span>
        }
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {stats.map((stat, index) => {
          const tone = usageTones[stat.tone];
          return (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.15 + index * 0.05 }}
              className="rounded-2xl border border-zinc-100 bg-zinc-50/60 p-4 transition-colors duration-300 hover:border-zinc-200 dark:border-zinc-800 dark:bg-zinc-800/40 dark:hover:border-zinc-700"
            >
              <div className="flex items-start justify-between">
                <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${tone.bg}`}>
                  <stat.icon size={16} className={`h-4 w-4 ${tone.text}`} />
                </div>
                <MiniBars heights={stat.bars} barClass={tone.bar} />
              </div>
              <p className="mt-3 text-xl font-black tracking-tight text-zinc-900 dark:text-white">{stat.value}</p>
              <p className="mt-0.5 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">{stat.label}</p>
              <p className="mt-1 text-[10px] text-zinc-400 dark:text-zinc-500">{stat.sub}</p>
            </motion.div>
          );
        })}
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────
//  Right column — Connection Health
// ──────────────────────────────────────────────

function ConnectionHealthCard() {
  const score = 100;
  const radius = 34;
  const circumference = 2 * Math.PI * radius;

  const rows = [
    { label: "Sync Success", value: "98%", pct: 98, bar: "bg-emerald-500" },
    { label: "API Response", value: "120ms", pct: 72, bar: "bg-brand-500" },
    { label: "Errors", value: "0", pct: 0, bar: "bg-zinc-300 dark:bg-zinc-600" },
  ];

  return (
    <Card id="health" delay={0.05}>
      <SectionHeader
        icon={GaugeIcon}
        iconBg="bg-emerald-50 dark:bg-emerald-950/40"
        iconColor="text-emerald-600 dark:text-emerald-400"
        title="Connection Health"
        subtitle="Real-time status"
      />

      <div className="flex items-center gap-4">
        <div className="relative flex h-20 w-20 shrink-0 items-center justify-center">
          <svg className="h-20 w-20 -rotate-90" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r={radius} fill="none" strokeWidth="7" className="stroke-zinc-100 dark:stroke-zinc-800" />
            <motion.circle
              cx="40"
              cy="40"
              r={radius}
              fill="none"
              stroke="#10b981"
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={circumference}
              initial={{ strokeDashoffset: circumference }}
              animate={{ strokeDashoffset: circumference * (1 - score / 100) }}
              transition={{ duration: 1, delay: 0.2, ease: "easeOut" }}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-xl font-black tracking-tight text-emerald-600 dark:text-emerald-400">{score}%</span>
          </div>
        </div>
        <div>
          <p className="text-xs font-bold text-zinc-900 dark:text-white">Health Score</p>
          <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-emerald-100/80 px-2.5 py-1 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            Healthy
          </span>
          <p className="mt-1.5 text-[10px] text-zinc-400 dark:text-zinc-500">All systems operational</p>
        </div>
      </div>

      <div className="mt-5 space-y-3.5 border-t border-zinc-100 pt-4 dark:border-zinc-800">
        {rows.map((row) => (
          <div key={row.label}>
            <div className="mb-1.5 flex items-center justify-between text-[11px]">
              <span className="font-medium text-zinc-500 dark:text-zinc-400">{row.label}</span>
              <span className="font-bold text-zinc-800 dark:text-zinc-200">{row.value}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${row.pct}%` }}
                transition={{ duration: 0.9, delay: 0.35, ease: "easeOut" }}
                className={`h-full rounded-full ${row.bar}`}
              />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────
//  Sync Statistics
// ──────────────────────────────────────────────

function SyncStatisticsCard({ integration, lastSync }: { integration: IntegrationConfig; lastSync: string | null }) {
  const stats = [
    { label: "Total Syncs", value: "128", icon: RefreshCwIcon },
    { label: "Records Synced", value: "12,482", icon: DatabaseIcon },
    { label: "Avg Sync Time", value: "8.4s", icon: ClockIcon },
    { label: "Last Sync", value: formatLastSync(lastSync), icon: ActivityStreamIcon },
  ];

  return (
    <Card id="sync-stats" delay={0.1}>
      <SectionHeader
        icon={TrendingUpIcon}
        iconBg="bg-brand-50 dark:bg-brand-950/40"
        iconColor="text-brand-600 dark:text-brand-400"
        title="Sync Statistics"
        subtitle={integration.name}
      />
      <div className="grid grid-cols-2 gap-3">
        {stats.map((stat, index) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.15 + index * 0.05 }}
            className="rounded-2xl border border-zinc-100 bg-zinc-50/60 p-3.5 dark:border-zinc-800 dark:bg-zinc-800/40"
          >
            <stat.icon size={13} className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500" />
            <p className="mt-2 text-base font-black tracking-tight text-zinc-900 dark:text-white">{stat.value}</p>
            <p className="mt-0.5 text-[10px] font-medium text-zinc-400 dark:text-zinc-500">{stat.label}</p>
          </motion.div>
        ))}
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────
//  Account
// ──────────────────────────────────────────────

function AccountCard({ integration, lastSync }: { integration: IntegrationConfig; lastSync: string | null }) {
  const email = integration.account;
  const initial = (email?.[0] ?? "?").toUpperCase();
  const isGoogle = integration.authenticationType === "google-oauth";

  return (
    <Card id="account" delay={0.15}>
      <SectionHeader
        icon={UserProfileIcon}
        iconBg="bg-sky-50 dark:bg-sky-950/40"
        iconColor="text-sky-600 dark:text-sky-400"
        title="Account"
        subtitle="Connected identity"
      />

      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-accent-500 text-sm font-black text-white shadow-md shadow-brand-500/25">
          {initial}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-zinc-900 dark:text-white">{email ?? "Not available"}</p>
          <p className="mt-0.5 text-[11px] text-zinc-400 dark:text-zinc-500">
            {authLabel(integration)} · {isGoogle ? "Google" : integration.name}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2.5 border-t border-zinc-100 pt-4 dark:border-zinc-800">
        <OverviewRow icon={CalendarIcon} label="Connected" value={formatLastSync(lastSync, "Today")} />
        <OverviewRow icon={ShieldCheckIcon} label="Permissions" value={<PermissionBadge level={integration.permissions} />} />
      </div>

      {isGoogle && (
        <a
          href={GOOGLE_OAUTH_MANAGE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-semibold text-brand-600 transition-colors hover:text-brand-500 dark:text-brand-400 dark:hover:text-brand-300"
        >
          Manage access in Google
          <ExternalLinkIcon size={11} className="h-2.5 w-2.5" />
        </a>
      )}
    </Card>
  );
}

// ──────────────────────────────────────────────
//  Quick Actions
// ──────────────────────────────────────────────

function QuickActionsCard({
  integration,
  isSyncing,
  onSync,
  onReauthorize,
  onRefreshPermissions,
}: {
  integration: IntegrationConfig;
  isSyncing: boolean;
  onSync: () => void;
  onReauthorize: () => void;
  onRefreshPermissions: () => void;
}) {
  const [testState, setTestState] = useState<"idle" | "testing" | "ok">("idle");

  const handleTest = useCallback(() => {
    if (testState === "testing") return;
    setTestState("testing");
    // No cleanup needed: a late timer just flips state to "ok" on an unmounted
    // card, which React ignores. The guard above prevents duplicate timers.
    setTimeout(() => setTestState("ok"), 1100);
  }, [testState]);

  const homeUrl = PLATFORM_HOMEPAGES[integration.id];

  const actions: {
    key: string;
    label: string;
    icon: IconType;
    onClick?: () => void;
    href?: string;
    accent?: boolean;
    status?: React.ReactNode;
  }[] = [
    {
      key: "sync",
      label: isSyncing ? "Syncing…" : "Sync Now",
      icon: RefreshCwIcon,
      onClick: onSync,
      accent: true,
      status: isSyncing ? <Loader2Icon size={11} className="h-2.5 w-2.5 animate-spin text-brand-600 dark:text-brand-400" /> : undefined,
    },
    {
      key: "reauthorize",
      label: "Reauthorize",
      icon: KeyIcon,
      onClick: onReauthorize,
    },
    {
      key: "test",
      label: testState === "testing" ? "Testing…" : "Test Connection",
      icon: PlugIcon,
      onClick: handleTest,
      status:
        testState === "testing" ? (
          <Loader2Icon size={11} className="h-2.5 w-2.5 animate-spin text-sky-600 dark:text-sky-400" />
        ) : testState === "ok" ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
            <CheckCircleIcon size={10} className="h-2.5 w-2.5" />
            120ms
          </span>
        ) : undefined,
    },
    { key: "refresh", label: "Refresh Permissions", icon: ShieldCheckIcon, onClick: onRefreshPermissions },
    ...(homeUrl ? [{ key: "open", label: `Open ${integration.name}`, icon: ExternalLinkIcon, href: homeUrl }] : []),
  ];

  return (
    <Card id="quick-actions" delay={0.2}>
      <SectionHeader
        icon={ZapIcon}
        iconBg="bg-amber-50 dark:bg-amber-950/40"
        iconColor="text-amber-600 dark:text-amber-400"
        title="Quick Actions"
        subtitle="Common tasks"
      />
      <div className="space-y-2">
        {actions.map((action) => {
          const content = (
            <>
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${action.accent ? "bg-brand-50 text-brand-600 dark:bg-brand-950/40 dark:text-brand-400" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"}`}>
                <action.icon size={13} className="h-3.5 w-3.5" />
              </span>
              <span className={`flex-1 text-left text-xs font-semibold ${action.accent ? "text-brand-700 dark:text-brand-300" : "text-zinc-600 dark:text-zinc-300"}`}>
                {action.label}
              </span>
              {action.status}
              {action.href && <ExternalLinkIcon size={12} className="h-3 w-3 text-zinc-300 dark:text-zinc-600" />}
            </>
          );
          const className =
            "group flex w-full items-center gap-2.5 rounded-xl border border-zinc-100 bg-white px-3 py-2.5 transition-all duration-200 hover:-translate-y-px hover:border-zinc-200 hover:bg-zinc-50 hover:shadow-sm active:translate-y-0 active:scale-[0.98] dark:border-zinc-800 dark:bg-zinc-800/40 dark:hover:border-zinc-700 dark:hover:bg-zinc-800";
          return action.href ? (
            <a key={action.key} href={action.href} target="_blank" rel="noopener noreferrer" className={className}>
              {content}
            </a>
          ) : (
            <button key={action.key} type="button" onClick={action.onClick} disabled={isSyncing && action.key === "sync"} className={className}>
              {content}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────
//  Danger Zone
// ──────────────────────────────────────────────

function DangerZoneCard({ integration, onDisconnect }: { integration: IntegrationConfig; onDisconnect: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.25 }}
      className="overflow-hidden rounded-3xl border border-red-100/70 bg-white shadow-sm transition-shadow duration-300 hover:shadow-md dark:border-red-950/40 dark:bg-zinc-900/90"
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-red-50/40 dark:hover:bg-red-950/20"
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-2 text-xs font-bold text-red-500 dark:text-red-400">
          <AlertTriangleIcon size={14} className="h-3.5 w-3.5" />
          Danger Zone
        </span>
        <ChevronDownIcon size={14} className={`h-3.5 w-3.5 text-zinc-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="border-t border-red-100/70 px-5 pb-4 pt-3.5 dark:border-red-950/40">
              <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                Disconnecting stops BrieflyAI from accessing your {integration.name}. You can reconnect at any time — no data is deleted.
              </p>
              <button
                type="button"
                onClick={onDisconnect}
                className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-red-200 bg-red-50/60 px-3.5 py-2 text-xs font-semibold text-red-600 transition-all hover:bg-red-100 active:scale-[0.98] dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-400 dark:hover:bg-red-950/50"
              >
                Disconnect {integration.name}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ──────────────────────────────────────────────
//  Empty state (not connected)
// ──────────────────────────────────────────────

function EmptyState({ integration, onConnect, mcpCount }: { integration: IntegrationConfig; onConnect: () => void; mcpCount: number }) {
  const accent = integration.accentColor;
  const benefits = [
    { icon: SparklesIcon, label: "AI Summaries", description: "Draft and summarize conversations" },
    { icon: SearchIcon, label: "Smart Search", description: "Semantic search across your data" },
    { icon: FileTextIcon, label: "Daily Digest", description: "A morning brief of what matters" },
    { icon: ZapIcon, label: "Draft Generation", description: "Compose replies in seconds" },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: 0.1 }}
      className="mt-8 flex flex-col items-center rounded-3xl border border-zinc-200/80 bg-white px-6 py-14 text-center shadow-sm sm:py-16 dark:border-zinc-800/80 dark:bg-zinc-900/90"
    >
      {/* Illustration */}
      <div className="relative mx-auto h-44 w-64">
        <div className="absolute inset-x-8 top-8 h-24 rounded-3xl opacity-30 blur-2xl" style={{ background: accent }} />
        <div className="absolute left-1/2 top-0 h-20 w-44 -translate-x-1/2 -rotate-6 rounded-2xl border border-zinc-200 bg-white p-3.5 shadow-sm dark:border-zinc-700 dark:bg-zinc-800">
          <div className="h-2 w-3/4 rounded-full bg-zinc-100 dark:bg-zinc-700" />
          <div className="mt-2 h-2 w-1/2 rounded-full bg-zinc-100 dark:bg-zinc-700" />
          <div className="mt-3 flex items-center gap-1.5">
            <span className="h-4 w-4 rounded-full bg-zinc-100 dark:bg-zinc-700" />
            <span className="h-1.5 w-1/3 rounded-full bg-zinc-100 dark:bg-zinc-700" />
          </div>
        </div>
        <div
          className="absolute left-1/2 top-6 h-24 w-48 -translate-x-1/2 rotate-3 rounded-2xl border p-3.5 shadow-lg backdrop-blur-sm"
          style={{ borderColor: `${accent}44`, background: `linear-gradient(135deg, ${accent}16, ${accent}05)` }}
        >
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl shadow-md" style={{ background: accent, color: "#fff" }}>
              <PlatformIcon platformId={integration.id} size={18} />
            </div>
            <div className="text-left">
              <div className="h-2 w-16 rounded-full" style={{ background: `${accent}55` }} />
              <div className="mt-1.5 h-1.5 w-10 rounded-full bg-zinc-200/80 dark:bg-zinc-700" />
            </div>
          </div>
          <div className="mt-3 space-y-1.5">
            <div className="h-1.5 w-full rounded-full bg-zinc-200/70 dark:bg-zinc-700/60" />
            <div className="h-1.5 w-2/3 rounded-full bg-zinc-200/70 dark:bg-zinc-700/60" />
          </div>
        </div>
        <motion.span
          animate={{ y: [0, -6, 0] }}
          transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
          className="absolute -right-1 top-1 flex h-9 w-9 items-center justify-center rounded-full bg-amber-100 text-sm text-amber-500 shadow-sm dark:bg-amber-950/50"
        >
          ✦
        </motion.span>
        <motion.span
          animate={{ y: [0, -8, 0] }}
          transition={{ duration: 5, repeat: Infinity, ease: "easeInOut", delay: 1 }}
          className="absolute -left-2 bottom-6 flex h-7 w-7 items-center justify-center rounded-full bg-brand-100 text-xs text-brand-500 shadow-sm dark:bg-brand-950/50"
        >
          ✦
        </motion.span>
        <motion.span
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 2.5, repeat: Infinity }}
          className="absolute right-8 bottom-0 h-2 w-2 rounded-full bg-emerald-400"
        />
      </div>

      <h2 className="mt-6 text-xl font-black tracking-tight text-zinc-900 dark:text-white sm:text-2xl">
        Connect {integration.name} to unlock AI
      </h2>
      <p className="mt-2 max-w-md text-xs leading-relaxed text-zinc-500 dark:text-zinc-400 sm:text-sm">
        BrieflyAI uses {integration.name} as a real-time data source for the AI assistant. Connect once and let AI summarize, search, and organize your data automatically.
      </p>

      <div className="mt-8 grid w-full max-w-lg grid-cols-1 gap-3 sm:grid-cols-2">
        {benefits.map((benefit, index) => (
          <motion.div
            key={benefit.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.25 + index * 0.06 }}
            className="flex items-center gap-3 rounded-2xl border border-zinc-100 bg-zinc-50/60 p-3.5 text-left transition-all duration-300 hover:-translate-y-0.5 hover:border-zinc-200 hover:bg-white hover:shadow-md dark:border-zinc-800 dark:bg-zinc-800/40 dark:hover:border-zinc-700 dark:hover:bg-zinc-800"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-brand-600 shadow-sm dark:bg-zinc-800 dark:text-brand-400">
              <benefit.icon size={16} className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold text-zinc-900 dark:text-white">{benefit.label}</p>
              <p className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-500">{benefit.description}</p>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={onConnect}
          className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-brand-600/25 transition-all hover:-translate-y-px hover:bg-brand-500 hover:shadow-xl hover:shadow-brand-600/30 active:translate-y-0 active:scale-95 dark:bg-brand-500 dark:hover:bg-brand-400"
        >
          <ExternalLinkIcon size={15} className="h-4 w-4" />
          Connect {integration.name}
        </button>
        <Link
          href="/dashboard/integrations"
          className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-xs font-semibold text-zinc-600 transition-all hover:bg-zinc-50 active:scale-95 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
        >
          <ArrowRightIcon size={13} className="h-3 w-3 rotate-180" />
          All Integrations
        </Link>
      </div>

      <p className="mt-6 flex items-center gap-1.5 text-[10px] font-medium text-zinc-400 dark:text-zinc-500">
        <SettingsIcon size={11} className="h-2.5 w-2.5" />
        {mcpCount} MCP tools will be available immediately after connecting
      </p>
    </motion.div>
  );
}

// ──────────────────────────────────────────────
//  Skeleton
// ──────────────────────────────────────────────

function PageSkeleton() {
  return (
    <div>
      <div className="animate-pulse">
        <div className="h-4 w-28 rounded bg-zinc-200 dark:bg-zinc-800" />
        <div className="mt-8 flex items-center gap-4">
          <div className="h-14 w-14 rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
          <div className="flex-1 space-y-2.5">
            <div className="h-6 w-40 rounded-md bg-zinc-200 dark:bg-zinc-800" />
            <div className="h-3 w-72 max-w-full rounded bg-zinc-100 dark:bg-zinc-800" />
            <div className="h-3 w-48 rounded bg-zinc-100 dark:bg-zinc-800" />
          </div>
        </div>
        <div className="mt-8 grid gap-5 lg:grid-cols-3 lg:gap-6">
          <div className="space-y-5 lg:col-span-2 lg:space-y-6">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-48 rounded-3xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
                <div className="mb-5 flex items-center gap-3">
                  <div className="h-9 w-9 rounded-xl bg-zinc-200 dark:bg-zinc-800" />
                  <div className="space-y-2">
                    <div className="h-3 w-28 rounded bg-zinc-200 dark:bg-zinc-800" />
                    <div className="h-2 w-20 rounded bg-zinc-100 dark:bg-zinc-800" />
                  </div>
                </div>
                <div className="space-y-2.5">
                  <div className="h-3 w-full rounded bg-zinc-100 dark:bg-zinc-800" />
                  <div className="h-3 w-4/5 rounded bg-zinc-100 dark:bg-zinc-800" />
                </div>
              </div>
            ))}
          </div>
          <div className="space-y-5 lg:space-y-6">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-40 rounded-3xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
                <div className="mb-4 h-9 w-9 rounded-xl bg-zinc-200 dark:bg-zinc-800" />
                <div className="space-y-2.5">
                  <div className="h-3 w-full rounded bg-zinc-100 dark:bg-zinc-800" />
                  <div className="h-3 w-2/3 rounded bg-zinc-100 dark:bg-zinc-800" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
//  Page
// ──────────────────────────────────────────────

export default function PlatformSettingsPage() {
  const params = useParams<{ platform: string }>();
  const platformId = params.platform;

  const {
    platforms,
    isLoading,
    connectPlatform,
    disconnectPlatform,
    updateIntegration,
    refetch,
    openConnectDialog,
  } = useIntegrationStatus();
  const confirmAction = useConfirmAction();

  const integration = platforms.find((p) => p.id === platformId) ?? integrationPlatforms.find((p) => p.id === platformId);
  const mcpTools = mcpToolsByPlatform[platformId] ?? [];

  // Client-side sync simulation — no sync API exists yet, so we drive the
  // "syncing" state locally and keep the store in sync with `updateIntegration`.
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(syncTimerRef.current), []);

  const status: ConnectionStatus = isSyncing ? "syncing" : (integration?.status ?? "not-connected");
  const isConnected = status === "connected" || status === "syncing";
  const lastSync = syncedAt ?? integration?.lastSync ?? null;

  const handleSyncNow = useCallback(() => {
    if (!integration || isSyncing) return;
    setIsSyncing(true);
    updateIntegration(platformId, { status: "syncing" });
    clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      setSyncedAt(new Date().toISOString());
      setIsSyncing(false);
      updateIntegration(platformId, { status: "connected" });
    }, 1800);
  }, [integration, isSyncing, platformId, updateIntegration]);

  const handleDisconnect = useCallback(() => {
    void confirmAction({
      title: "Disconnect?",
      message: `Disconnecting will stop BrieflyAI from accessing your ${integration?.name} until you reconnect. No synced data is deleted.`,
      confirmLabel: "Disconnect",
      busyLabel: "Disconnecting…",
      onConfirm: () => disconnectPlatform(platformId),
    });
  }, [confirmAction, disconnectPlatform, integration?.name, platformId]);

  const handleManagePermissions = useCallback(() => {
    document.getElementById("permissions")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  /**
   * Reauthorize:
   * - Google OAuth → Google's app-permissions page (revoke/re-grant there).
   * - Other OAuth → re-run the provider consent flow in a new tab.
   * - Bot-token (Telegram) → open the shared connect dialog to paste a new token.
   */
  const handleReauthorize = useCallback(() => {
    if (integration?.authenticationType === "google-oauth") {
      window.open(GOOGLE_OAUTH_MANAGE_URL, "_blank", "noopener,noreferrer");
      return;
    }
    if (integration?.authenticationType === "oauth") {
      const route = OAUTH_CONNECT_ROUTE[integration.id];
      if (route) {
        window.open(`/api/integrations/${route}?platform=${integration.id}`, "_blank", "noopener,noreferrer");
      }
      return;
    }
    if (integration?.authenticationType === "bot-token") {
      openConnectDialog(integration.id);
    }
  }, [integration, openConnectDialog]);

  if (!integration) {
    return (
      <div className="flex flex-col items-center gap-5 rounded-3xl border-2 border-dashed border-zinc-200 px-6 py-16 text-center dark:border-zinc-700">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-400 dark:bg-zinc-800">
          <AlertTriangleIcon size={24} className="h-6 w-6" />
        </div>
        <div>
          <h2 className="text-lg font-black text-zinc-900 dark:text-white">Platform Not Found</h2>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Unknown platform: <strong className="text-zinc-800 dark:text-zinc-200">{platformId}</strong>
          </p>
        </div>
        <Link
          href="/dashboard/integrations"
          className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-xs font-bold text-white transition-all hover:bg-brand-500"
        >
          <ArrowRightIcon size={14} className="h-3.5 w-3.5 rotate-180" />
          Back to Integrations
        </Link>
      </div>
    );
  }

  if (isLoading) {
    return <PageSkeleton />;
  }

  return (
    <div className="pb-28 lg:pb-8">
      <HeroHeader
        integration={integration}
        isSyncing={isSyncing}
        lastSync={lastSync}
        onSync={handleSyncNow}
        onManagePermissions={handleManagePermissions}
        onDisconnect={handleDisconnect}
      />

      <StatusChips
        integration={integration}
        isConnected={isConnected}
        isSyncing={isSyncing}
        lastSync={lastSync}
        mcpCount={mcpTools.length}
      />

      {isConnected ? (
        <div className="mt-8 grid gap-5 lg:grid-cols-3 lg:gap-6">
          {/* ─── Main column (70%) ─── */}
          <div className="space-y-5 lg:col-span-2 lg:space-y-6">
            <ConnectionOverviewCard integration={integration} status={status} lastSync={lastSync} />
            <PermissionsSection integration={integration} />
            <McpToolsSection integration={integration} tools={mcpTools} />
            <TimelineSection integration={integration} isSyncing={isSyncing} onSync={handleSyncNow} />
            <UsageAnalyticsSection integration={integration} />
          </div>

          {/* ─── Sidebar column (30%) ─── */}
          <div className="space-y-5 lg:space-y-6">
            <ConnectionHealthCard />
            <SyncStatisticsCard integration={integration} lastSync={lastSync} />
            <AccountCard integration={integration} lastSync={lastSync} />
            <QuickActionsCard
              integration={integration}
              isSyncing={isSyncing}
              onSync={handleSyncNow}
              onReauthorize={handleReauthorize}
              onRefreshPermissions={() => void refetch()}
            />
            <DangerZoneCard integration={integration} onDisconnect={handleDisconnect} />
          </div>
        </div>
      ) : (
        <EmptyState integration={integration} onConnect={() => connectPlatform(platformId)} mcpCount={mcpTools.length} />
      )}

      {/* ─── Mobile sticky action bar ─── */}
      {isConnected && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-200 bg-white/90 p-3 backdrop-blur-lg lg:hidden dark:border-zinc-800 dark:bg-zinc-900/90">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <button
              type="button"
              onClick={handleSyncNow}
              disabled={isSyncing}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-3 text-xs font-bold text-white shadow-md shadow-brand-600/20 transition-all active:scale-95 disabled:opacity-60 dark:bg-brand-500"
            >
              {isSyncing ? <Loader2Icon size={14} className="h-3.5 w-3.5 animate-spin" /> : <RefreshCwIcon size={14} className="h-3.5 w-3.5" />}
              {isSyncing ? "Syncing…" : "Sync Now"}
            </button>
            <button
              type="button"
              onClick={handleDisconnect}
              className="inline-flex items-center justify-center rounded-xl border border-red-200 bg-white px-4 py-3 text-xs font-semibold text-red-600 transition-all active:scale-95 dark:border-red-900/60 dark:bg-zinc-800 dark:text-red-400"
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
