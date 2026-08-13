"use client";

import React from "react";
import { SettingsCard } from "./SettingsCard";
import { SegmentedControl } from "./SegmentedControl";
import { SettingToggle } from "./SettingToggle";
import { useToast } from "./Toast";
import { SunIcon, MoonIcon, MonitorIcon } from "./icons";
import { applyTheme } from "./theme";
import type { SettingsPreferences } from "@/lib/settings/types";

interface AppearanceCardProps {
  preferences: SettingsPreferences;
  /** Persist a patch; resolves with true on success, false on failure. */
  onChange: (patch: Partial<SettingsPreferences>) => Promise<boolean>;
}

/** Appearance: theme + compact mode. */
export function AppearanceCard({ preferences, onChange }: AppearanceCardProps) {
  const { show } = useToast();

  const changeTheme = async (theme: SettingsPreferences["theme"]) => {
    const previous = preferences.theme;
    applyTheme(theme);
    const ok = await onChange({ theme });
    if (ok) {
      show("Theme updated");
    } else {
      applyTheme(previous);
      show("Couldn't save settings");
    }
  };

  return (
    <SettingsCard>
      <div className="space-y-5">
        <SegmentedControl
          label="Theme"
          value={preferences.theme}
          onChange={(value) => void changeTheme(value as SettingsPreferences["theme"])}
          options={[
            { value: "light", label: "Light", icon: SunIcon },
            { value: "dark", label: "Dark", icon: MoonIcon },
            { value: "system", label: "System", icon: MonitorIcon },
          ]}
        />

        <div className="border-t border-zinc-100 dark:border-zinc-800" />

        <SettingToggle
          label="Compact Mode"
          description="Reduce spacing for a denser interface."
          checked={preferences.compactMode}
          onChange={(compactMode) => {
            void (async () => {
              const ok = await onChange({ compactMode });
              show(ok ? "Settings saved" : "Couldn't save settings");
            })();
          }}
        />
      </div>
    </SettingsCard>
  );
}
