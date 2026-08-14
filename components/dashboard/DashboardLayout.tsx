"use client";

import React, { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { Sidebar, defaultNavItems } from "./Sidebar";
import { DashboardHeader } from "./DashboardHeader";
import { X } from "lucide-react";

interface DashboardLayoutProps {
  children: React.ReactNode;
  userEmail?: string;
  userFullName?: string | null;
  onSignOut?: () => void;
}

export const DashboardLayout: React.FC<DashboardLayoutProps> = ({
  children,
  userEmail,
  userFullName,
  onSignOut,
}) => {
  const [isCollapsed, setIsCollapsed] = useState<boolean>(false);
  const [isMobileOpen, setIsMobileOpen] = useState<boolean>(false);
  const [isDarkMode, setIsDarkMode] = useState<boolean>(false);
  const pathname = usePathname();

  // Synchronize initial dark mode state from localStorage & system preference
  useEffect(() => {
    const savedTheme = localStorage.getItem("theme");
    const isSystemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const initialDark =
      savedTheme === "dark" || ((savedTheme === "system" || !savedTheme) && isSystemDark);

    setIsDarkMode(initialDark);
    if (initialDark) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }


    // Follow system changes while the user is on the "system" theme.
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      const current = localStorage.getItem("theme");
      if (current === "system") {
        const nextDark = event.matches;
        setIsDarkMode(nextDark);
        document.documentElement.classList.toggle("dark", nextDark);
      }
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // Reconcile with the persisted preference — the DB is the single source of
  // truth for the theme. This keeps the quick header toggle and the
  // Settings → Appearance card in sync in both directions:
  //   • changing the theme in Settings now applies across the whole app, and
  //   • toggling in the header is persisted, so visiting Settings can never
  //     flip the page back to dark (e.g. a stale "system" default).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings");
        const body = await res.json().catch(() => null);
        if (cancelled || !res.ok || !body?.data?.preferences?.theme) return;
        const dbTheme: string = body.data.preferences.theme;
        if (dbTheme !== "light" && dbTheme !== "dark" && dbTheme !== "system") return;
        // Already in sync — avoid unnecessary work and class churn.
        const applied = localStorage.getItem("theme") ?? "system";
        if (dbTheme === applied) return;
        const dbDark =
          dbTheme === "dark" ||
          (dbTheme === "system" &&
            window.matchMedia("(prefers-color-scheme: dark)").matches);
        localStorage.setItem("theme", dbTheme);
        setIsDarkMode(dbDark);
        document.documentElement.classList.toggle("dark", dbDark);
      } catch {
        // Unauthenticated or offline — keep the local choice.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggleDarkMode = () => {
    const nextDark = !isDarkMode;
    const nextTheme = nextDark ? "dark" : "light";
    document.documentElement.classList.toggle("dark", nextDark);
    localStorage.setItem("theme", nextTheme);
    setIsDarkMode(nextDark);
    // Persist the choice so Settings → Appearance stays in sync (the DB is
    // the source of truth). Best-effort — on failure the local change stays.
    void fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferences: { theme: nextTheme } }),
    }).catch(() => {});
  };

  const handleToggleCollapse = () => {
    setIsCollapsed((prev) => !prev);
  };

  // Find active navigation item title for header breadcrumb
  const currentNavItem = defaultNavItems.find(
    (item) => pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href))
  );
  
  let activeTitle = currentNavItem ? currentNavItem.label : "Dashboard";
  if (pathname === "/dashboard/pricing") {
    activeTitle = "Pricing & Upgrades";
  }

  return (
    <div className="flex min-h-screen bg-zinc-50 font-sans text-zinc-900 transition-colors duration-300 dark:bg-[#0b0f1a] dark:text-zinc-100">
      {/* ─────────── DESKTOP SIDEBAR ─────────── */}
      <div className="hidden lg:block shrink-0 sticky top-0 h-screen z-30">
        <Sidebar
          isCollapsed={isCollapsed}
          onToggleCollapse={handleToggleCollapse}
          userEmail={userEmail}
          userFullName={userFullName}
          onSignOut={onSignOut}
        />
      </div>

      {/* ─────────── MOBILE OVERLAY DRAWER ─────────── */}
      {isMobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          {/* Backdrop Blur Overlay */}
          <div
            className="fixed inset-0 bg-zinc-900/60 backdrop-blur-sm transition-opacity"
            onClick={() => setIsMobileOpen(false)}
          />

          {/* Slide-out Sidebar Content */}
          <div className="relative flex w-72 max-w-[85vw] flex-1 flex-col bg-white dark:bg-zinc-900 shadow-2xl transition-transform duration-300 ease-in-out">
            <button
              type="button"
              onClick={() => setIsMobileOpen(false)}
              className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            >
              <X className="h-5 w-5" />
            </button>

            <Sidebar
              isCollapsed={false}
              onToggleCollapse={() => {}}
              userEmail={userEmail}
              userFullName={userFullName}
              onSignOut={onSignOut}
              isMobileDrawer={true}
              onSelectNavItem={() => setIsMobileOpen(false)}
            />
          </div>
        </div>
      )}

      {/* ─────────── MAIN CONTENT WRAPPER ─────────── */}
      <div className="flex flex-1 flex-col min-w-0">
        <DashboardHeader
          onToggleMobileDrawer={() => setIsMobileOpen(true)}
          activeItemTitle={activeTitle}
          isDarkMode={isDarkMode}
          onToggleDarkMode={handleToggleDarkMode}
          userEmail={userEmail}
          userFullName={userFullName}
        />

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
};
