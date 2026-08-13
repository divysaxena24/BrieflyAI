"use client";

import React, { useState } from "react";
import { LogOutIcon, PencilIcon, CheckIcon, XIcon } from "@/components/settings/icons";
import { SettingsCard } from "./SettingsCard";
import { SettingButton } from "./SettingButton";
import { useToast } from "./Toast";
import { signOut } from "@/app/actions";
import type { SettingsUser } from "@/lib/settings/types";

interface AccountCardProps {
  user: SettingsUser;
  plan: string;
  onProfileUpdated: (user: SettingsUser) => void;
}

function initialsOf(user: SettingsUser): string {
  const name = user.fullName?.trim();
  if (name) {
    const parts = name.split(/\s+/);
    return (parts[0][0] ?? "").toUpperCase() + (parts[1]?.[0] ?? "").toUpperCase();
  }
  return (user.email[0] ?? "?").toUpperCase();
}

function memberSince(user: SettingsUser): string {
  if (!user.createdAt) return "—";
  return new Date(user.createdAt).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

/** Account section: identity, plan, edit profile, sign out. */
export function AccountCard({ user, plan, onProfileUpdated }: AccountCardProps) {
  const { show } = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.fullName ?? "");
  const [saving, setSaving] = useState(false);

  const saveProfile = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: { fullName: trimmed } }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.errors?.[0]?.message ?? body?.message ?? "Could not save profile");
      onProfileUpdated(body.data?.user);
      setEditing(false);
      show("Profile updated");
    } catch (err) {
      show(err instanceof Error ? err.message : "Could not save profile");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard>
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-tr from-brand-600 via-brand-500 to-accent-500 text-xl font-black text-white shadow-lg shadow-brand-500/25">
            {initialsOf(user)}
          </div>
          <div className="min-w-0">
            <p className="truncate text-base font-black tracking-tight text-zinc-900 dark:text-white">
              {user.fullName ?? "Your account"}
            </p>
            <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">{user.email}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-bold text-brand-700 dark:bg-brand-950/50 dark:text-brand-300">
                {plan === "free" ? "Free plan" : `${plan} plan`}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-bold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                Member since {memberSince(user)}
              </span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <SettingButton variant="secondary" onClick={() => setEditing((v) => !v)}>
            <PencilIcon size={13} className="h-3.5 w-3.5" />
            {editing ? "Cancel" : "Edit Profile"}
          </SettingButton>
          <SettingButton variant="secondary" onClick={() => void signOut()}>
            <LogOutIcon size={13} className="h-3.5 w-3.5" />
            Sign Out
          </SettingButton>
        </div>
      </div>

      {editing && (
        <div className="mt-5 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <label htmlFor="profile-name" className="block text-xs font-bold text-zinc-900 dark:text-white">
            Full name
          </label>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              id="profile-name"
              type="text"
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveProfile();
              }}
              className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3.5 py-2.5 text-xs text-zinc-900 transition-colors focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-zinc-700 dark:bg-zinc-800 dark:text-white dark:focus:border-brand-400 sm:max-w-xs"
            />
            <div className="flex items-center gap-2">
              <SettingButton variant="primary" loading={saving} onClick={() => void saveProfile()}>
                <CheckIcon size={13} className="h-3.5 w-3.5" />
                Save
              </SettingButton>
              <SettingButton variant="secondary" onClick={() => setEditing(false)} aria-label="Cancel editing">
                <XIcon size={13} className="h-3.5 w-3.5" />
              </SettingButton>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-500">
            Email is managed by your sign-in provider and can&apos;t be changed here.
          </p>
        </div>
      )}
    </SettingsCard>
  );
}
