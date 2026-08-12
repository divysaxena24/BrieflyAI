import React from "react";
import { PageHeader } from "@/components/dashboard";
import { AiAgentIcon, AiSparklesIcon, UpgradeZapIcon, SettingsIcon } from "@/components/dashboard/icons";

export default function AiAgentPage() {
  return (
    <div>
      <PageHeader
        title="AI Agent Studio"
        description="Configure your personal AI assistant preferences, model behavior, and custom prompt instructions."
        badge="Active Engine: GPT-4o / Gemini 1.5"
        action={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-xs font-bold text-white shadow-md shadow-brand-600/20 transition-all hover:bg-brand-500">
            <AiSparklesIcon size={16} /> Deploy New Agent
          </button>
        }
      />

      {/* Main Grid Card Container */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* Card 1: Agent Persona */}
        <div className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-950/50 dark:text-brand-400">
              <AiAgentIcon size={20} />
            </div>
            <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-bold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
              Online
            </span>
          </div>
          <h3 className="text-base font-bold text-zinc-900 dark:text-white">
            Briefly Executive Assistant
          </h3>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            Main agent responsible for inbox filtering, high-priority summary extraction, and event detection.
          </p>

          <div className="mt-6 space-y-2 text-xs">
            <div className="flex justify-between border-b border-zinc-100 py-2 dark:border-zinc-800">
              <span className="text-zinc-400">Tone</span>
              <span className="font-semibold text-zinc-800 dark:text-zinc-200">Concise & Professional</span>
            </div>
            <div className="flex justify-between border-b border-zinc-100 py-2 dark:border-zinc-800">
              <span className="text-zinc-400">Auto-Reply Drafts</span>
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">Enabled</span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-zinc-400">Sensitivity Level</span>
              <span className="font-semibold text-zinc-800 dark:text-zinc-200">High (Filter Spam)</span>
            </div>
          </div>
        </div>

        {/* Card 2: Custom Prompt Rules */}
        <div className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 text-amber-600 dark:bg-amber-950/50 dark:text-amber-400">
              <SettingsIcon size={20} />
            </div>
            <span className="text-xs text-zinc-400">3 Rules Configured</span>
          </div>
          <h3 className="text-base font-bold text-zinc-900 dark:text-white">
            Custom Instructions
          </h3>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            Define specific guidelines for how AI handles messages from VIP contacts or specific subject lines.
          </p>

          <div className="mt-4 space-y-2">
            {[
              "Flag any email containing 'Invoice' or 'Urgent'",
              "Summarize Telegram group messages longer than 5 chats",
              "Never auto-respond to newsletters",
            ].map((rule, idx) => (
              <div key={idx} className="rounded-xl bg-zinc-50 p-2.5 text-xs text-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-300">
                ⚡ {rule}
              </div>
            ))}
          </div>
        </div>

        {/* Card 3: Model Usage */}
        <div className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-violet-600 dark:bg-violet-950/50 dark:text-violet-400">
              <UpgradeZapIcon size={20} />
            </div>
            <span className="text-xs font-bold text-brand-600 dark:text-brand-400">Pro Tier</span>
          </div>
          <h3 className="text-base font-bold text-zinc-900 dark:text-white">
            AI Token Capacity
          </h3>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            Track computational usage across summaries, embeddings, and chat interactions.
          </p>

          <div className="mt-6">
            <div className="mb-2 flex justify-between text-xs">
              <span className="text-zinc-500">Monthly Allowance</span>
              <span className="font-bold text-zinc-900 dark:text-white">45% used</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div className="h-full w-[45%] rounded-full bg-gradient-to-r from-brand-500 to-accent-500" />
            </div>
            <p className="mt-3 text-[11px] text-zinc-400">
              Resets on the 1st of next month.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
