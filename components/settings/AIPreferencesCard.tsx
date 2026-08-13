"use client";

import React from "react";
import { SettingsCard } from "./SettingsCard";
import { SegmentedControl } from "./SegmentedControl";
import { SettingSelect } from "./SettingSelect";
import { SettingToggle } from "./SettingToggle";
import { useToast } from "./Toast";
import { SparklesIcon, GlobeIcon } from "./icons";
import type { SettingsPreferences } from "@/lib/settings/types";

interface AIPreferencesCardProps {
  preferences: SettingsPreferences;
  /** Persist a patch; resolves with true on success, false on failure. */
  onChange: (patch: Partial<SettingsPreferences>) => Promise<boolean>;
}

/** AI Preferences: how the assistant responds to the user. */
export function AIPreferencesCard({ preferences, onChange }: AIPreferencesCardProps) {
  const { show } = useToast();

  const update = async (patch: Partial<SettingsPreferences>, toastMessage: string) => {
    const ok = await onChange(patch);
    show(ok ? toastMessage : "Couldn't save settings");
  };

  return (
    <SettingsCard>
      <div className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <SegmentedControl
            label="Response Style"
            value={preferences.responseStyle}
            onChange={(value) =>
              void update(
                { responseStyle: value as SettingsPreferences["responseStyle"] },
                "Response style updated",
              )
            }
            options={[
              { value: "concise", label: "Concise" },
              { value: "balanced", label: "Balanced" },
              { value: "detailed", label: "Detailed" },
            ]}
          />

          <SettingSelect
            label="Preferred Language"
            value={preferences.preferredLanguage}
            onChange={(value) =>
              void update(
                { preferredLanguage: value as SettingsPreferences["preferredLanguage"] },
                "Language updated",
              )
            }
            options={[
              { value: "english", label: "English" },
              { value: "hindi", label: "Hindi" },
            ]}
          />
        </div>

        <div className="border-t border-zinc-100 dark:border-zinc-800" />

        <SettingToggle
          label="AI Memory"
          description="Remember previous conversations so follow-up questions have context."
          checked={preferences.aiMemory}
          onChange={(aiMemory) => void update({ aiMemory }, "AI memory updated")}
        />

        <div className="flex items-start gap-2.5 rounded-xl bg-zinc-50 px-3.5 py-3 dark:bg-zinc-800/50">
          <SparklesIcon size={14} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500 dark:text-brand-400" />
          <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            These preferences shape how your summaries are generated. Response style and language
            apply to new requests.
          </p>
        </div>

        <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
          <GlobeIcon size={12} className="h-3 w-3" />
          Preferences are saved instantly and synced to your account.
        </div>
      </div>
    </SettingsCard>
  );
}
