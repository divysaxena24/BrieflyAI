"use client";

import React from "react";

interface SettingsSectionProps {
  /** Anchor id used by the sidebar scroll-spy. */
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}

/** A titled settings section. Cards inside provide their own container. */
export function SettingsSection({ id, title, description, children }: SettingsSectionProps) {
  return (
    <section id={id} className="scroll-mt-24" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="text-lg font-black tracking-tight text-zinc-900 dark:text-white">
        {title}
      </h2>
      {description && (
        <p className="mt-1 max-w-xl text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          {description}
        </p>
      )}
      <div className="mt-4">{children}</div>
    </section>
  );
}
