"use client";

import React, { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/dashboard";
import {
  AccountCard,
  AIPreferencesCard,
  AppearanceCard,
  IntegrationsCard,
  PrivacyCard,
  SettingsSection,
  SettingsSidebar,
  ToastProvider,
  applyTheme,
} from "@/components/settings";
import {
  BotIcon,
  PaletteIcon,
  PlugIcon,
  ShieldIcon,
  UserIcon,
} from "@/components/settings/icons";
import type { SettingsData, SettingsPreferences } from "@/lib/settings/types";

const NAV_ITEMS = [
  { id: "account", label: "Account", icon: UserIcon },
  { id: "ai-preferences", label: "AI Preferences", icon: BotIcon },
  { id: "integrations", label: "Integrations", icon: PlugIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "privacy", label: "Privacy", icon: ShieldIcon },
];

function SettingsSkeleton() {
  return (
    <div className="space-y-6">
      {[0, 1, 2].map((i) => (
        <div key={i} className="animate-pulse rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
          <div className="h-4 w-1/3 rounded-md bg-zinc-200 dark:bg-zinc-800" />
          <div className="mt-3 h-3 w-1/2 rounded bg-zinc-100 dark:bg-zinc-800/60" />
          <div className="mt-6 h-24 rounded-xl bg-zinc-100 dark:bg-zinc-800/60" />
        </div>
      ))}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <ToastProvider>
      <SettingsCenter />
    </ToastProvider>
  );
}

function SettingsCenter() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState("account");

  // Load settings + apply the persisted theme on first render.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings");
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.data) {
          if (!cancelled) {
            setError(body?.message ?? "Couldn't load your settings.");
            setLoading(false);
          }
          return;
        }
        if (!cancelled) {
          setSettings(body.data);
          applyTheme(body.data.preferences.theme);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setError("Couldn't load your settings. Please try again.");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Scroll-spy: highlight the section currently in view.
  useEffect(() => {
    if (loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveId(entry.target.id);
        }
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    for (const item of NAV_ITEMS) {
      const el = document.getElementById(item.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [loading]);

  const scrollTo = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  /** Persist a preferences patch (optimistic, rolls back on failure). */
  const updatePreferences = useCallback(
    async (patch: Partial<SettingsPreferences>): Promise<boolean> => {
      const previous = settings;
      setSettings((current) =>
        current ? { ...current, preferences: { ...current.preferences, ...patch } } : current,
      );
      try {
        const res = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preferences: patch }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error("Request failed");
        if (body?.data?.preferences) {
          setSettings((current) =>
            current ? { ...current, preferences: body.data.preferences } : current,
          );
        }
        return true;
      } catch {
        setSettings(previous);
        return false;
      }
    },
    [settings],
  );

  if (loading) {
    return (
      <div>
        <PageHeader
          title="Settings"
          description="Manage your account, AI preferences, integrations, appearance, and privacy."
        />
        <SettingsSkeleton />
      </div>
    );
  }

  if (error || !settings) {
    return (
      <div>
        <PageHeader
          title="Settings"
          description="Manage your account, AI preferences, integrations, appearance, and privacy."
        />
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
          <p className="font-bold">Couldn&apos;t load settings</p>
          <p className="mt-1 text-xs">{error ?? "Something went wrong."}</p>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              setError(null);
              window.location.reload();
            }}
            className="mt-3 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-red-500"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Manage your account, AI preferences, integrations, appearance, and privacy."
      />

      <div className="lg:grid lg:grid-cols-[14rem_1fr] lg:items-start lg:gap-8">
        <SettingsSidebar items={NAV_ITEMS} activeId={activeId} onSelect={scrollTo} />

        <div className="min-w-0 space-y-10">
          <SettingsSection
            id="account"
            title="Account"
            description="Your profile and plan information."
          >
            <AccountCard
              user={settings.user}
              plan={settings.plan}
              onProfileUpdated={(user) => setSettings((current) => (current ? { ...current, user } : current))}
            />
          </SettingsSection>

          <SettingsSection
            id="ai-preferences"
            title="AI Preferences"
            description="How the AI assistant responds to you."
          >
            <AIPreferencesCard
              preferences={settings.preferences}
              onChange={updatePreferences}
            />
          </SettingsSection>

          <SettingsSection
            id="integrations"
            title="Integrations"
            description="Connect or disconnect the services BrieflyAI can read."
          >
            <IntegrationsCard />
          </SettingsSection>

          <SettingsSection
            id="appearance"
            title="Appearance"
            description="Theme and display preferences for your workspace."
          >
            <AppearanceCard
              preferences={settings.preferences}
              onChange={updatePreferences}
            />
          </SettingsSection>

          <SettingsSection
            id="privacy"
            title="Privacy"
            description="Export, clear, or delete your data."
          >
            <PrivacyCard />
          </SettingsSection>
        </div>
      </div>
    </div>
  );
}
