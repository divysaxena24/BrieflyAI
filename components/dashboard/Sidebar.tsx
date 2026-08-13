"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  DashboardIcon,
  MessageIcon,
  FeaturesIcon,
  IntegrationsIcon,
  SettingsIcon,
  AiSparklesIcon,
  CollapseLeftIcon,
  ExpandRightIcon,
  SignOutIcon,
} from "./icons";
import { SidebarItem } from "./SidebarItem";
import { useConfirmAction, isRedirectError } from "@/components/ConfirmationDialog";

export interface NavItemConfig {
  id: string;
  label: string;
  href: string;
  icon: React.ComponentType<any>;
  badge?: string | number;
  badgeColor?: string;
}

export const defaultNavItems: NavItemConfig[] = [
  { id: "dashboard", label: "Dashboard", href: "/dashboard", icon: DashboardIcon },
  { id: "ai-chat", label: "AI Assistant", href: "/dashboard/ai-chat", icon: MessageIcon },
  { id: "features", label: "Features", href: "/dashboard/features", icon: FeaturesIcon },
  { id: "integrations", label: "Integrations", href: "/dashboard/integrations", icon: IntegrationsIcon },
  { id: "settings", label: "Settings", href: "/dashboard/settings", icon: SettingsIcon },
];

interface SidebarProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  userEmail?: string;
  userFullName?: string | null;
  onSignOut?: () => void;
  isMobileDrawer?: boolean;
  onSelectNavItem?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  isCollapsed,
  onToggleCollapse,
  userEmail,
  userFullName,
  onSignOut,
  isMobileDrawer = false,
  onSelectNavItem,
}) => {
  const pathname = usePathname();
  const collapsed = isMobileDrawer ? false : isCollapsed;
  const confirmAction = useConfirmAction();

  const initials = userFullName
    ? userFullName
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : userEmail
    ? userEmail[0].toUpperCase()
    : "U";

  return (
    <aside
      className={`flex flex-col border-r border-zinc-200/80 bg-white transition-all duration-300 dark:border-zinc-800/80 dark:bg-zinc-900/90 ${
        isMobileDrawer
          ? "w-full h-full"
          : collapsed
          ? "w-20 h-screen"
          : "w-64 h-screen"
      }`}
    >
      {/* ── Header: Brand Logo & Title + Collapse Toggle Button ── */}
      <div
        className={`flex h-16 items-center border-b border-zinc-200/80 px-4 dark:border-zinc-800/80 ${
          collapsed ? "justify-center" : "justify-between"
        }`}
      >
        <Link
          href="/"
          aria-label="BrieflyAI home"
          className="flex items-center overflow-hidden transition-all hover:opacity-90"
        >
          {!collapsed && (
            <div className="flex flex-col truncate">
              <span className="text-base font-extrabold tracking-tight text-zinc-900 dark:text-white">
                Briefly<span className="text-brand-600 dark:text-brand-400">AI</span>
              </span>
              <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">
                SaaS Dashboard
              </span>
            </div>
          )}
        </Link>

        {/* Collapse toggle icon button for desktop */}
        {!isMobileDrawer && (
          <button
            type="button"
            onClick={onToggleCollapse}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            {collapsed ? (
              <ExpandRightIcon size={20} className="h-5 w-5" />
            ) : (
              <CollapseLeftIcon size={20} className="h-5 w-5" />
            )}
          </button>
        )}
      </div>

      {/* ── Main Navigation ── */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-1.5 scrollbar-thin">
        {!collapsed && (
          <p className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            Navigation
          </p>
        )}

        {defaultNavItems.map((item) => {
          const isActive = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href));
          return (
            <SidebarItem
              key={item.id}
              id={item.id}
              label={item.label}
              href={item.href}
              icon={item.icon}
              active={isActive}
              isCollapsed={collapsed}
              badge={item.badge}
              badgeColor={item.badgeColor}
              onClick={onSelectNavItem}
            />
          );
        })}
      </div>

      {/* ── Bottom Section: User Footer ── */}
      <div className="mt-auto border-t border-zinc-200/80 p-3 dark:border-zinc-800/80">
        <div
          className={`flex items-center gap-3 rounded-xl p-2 transition-colors ${
            collapsed ? "justify-center" : "bg-zinc-50 dark:bg-zinc-800/50"
          }`}
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-xs font-bold text-brand-700 dark:bg-brand-900/60 dark:text-brand-300 ring-2 ring-brand-500/20">
            {initials}
          </div>

          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-bold text-zinc-900 dark:text-zinc-100">
                {userFullName || "Briefly User"}
              </p>
              <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                {userEmail || "user@brieflyai.com"}
              </p>
            </div>
          )}

          {!collapsed && onSignOut && (
            <button
              type="button"
              onClick={() =>
                void confirmAction({
                  title: "Are you sure?",
                  message:
                    "Logging out will end your current BrieflyAI session. You'll need to sign in again to access your dashboard.",
                  confirmLabel: "Logout",
                  busyLabel: "Logging out…",
                  onConfirm: async () => {
                    try {
                      await onSignOut();
                    } catch (err) {
                      // Server actions that call redirect() throw internally;
                      // navigation still happens. Surface only real failures.
                      if (!isRedirectError(err)) throw err;
                    }
                  },
                })
              }
              title="Sign Out"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
            >
              <SignOutIcon size={16} className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
};
