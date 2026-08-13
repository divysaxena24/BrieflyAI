"use client";

import React, { useMemo } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { useDashboardData, type DashboardConversation } from "./useDashboardData";
import { formatRelativeTime } from "@/lib/utils/time";
import { AiSparklesIcon, MessageIcon } from "@/components/dashboard/icons";

/** Derive a display title for a conversation (metadata title or first user message). */
function conversationTitle(conversation: DashboardConversation): string {
  if (conversation.metadata.title?.trim()) return conversation.metadata.title.trim();
  const firstUser = conversation.messages.find((m) => m.role === "user");
  const content = firstUser?.content.trim() ?? "AI conversation";
  return content.length > 72 ? `${content.slice(0, 72)}…` : content;
}

/**
 * Recent AI Conversations: the user's last 5 AI requests, sourced from the
 * real conversations API. Shows an empty state when there are none.
 */
export const RecentConversations: React.FC = () => {
  const { conversations, loading } = useDashboardData();

  const recent = useMemo(
    () =>
      [...conversations]
        .sort(
          (a, b) =>
            Date.parse(b.metadata.updatedAt) - Date.parse(a.metadata.updatedAt)
        )
        .slice(0, 5),
    [conversations],
  );

  return (
    <div className="flex h-full flex-col rounded-3xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
      <div className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageIcon size={18} className="h-5 w-5 text-brand-600 dark:text-brand-400" />
          <h2 className="text-base font-bold text-zinc-900 dark:text-white">
            Recent AI Conversations
          </h2>
        </div>
        <Link
          href="/dashboard/ai-chat"
          className="text-[11px] font-bold text-brand-600 transition-colors hover:text-brand-500 dark:text-brand-400"
        >
          Open Assistant →
        </Link>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex animate-pulse items-center gap-3">
              <div className="h-8 w-8 shrink-0 rounded-lg bg-zinc-200 dark:bg-zinc-800" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-3/4 rounded bg-zinc-200 dark:bg-zinc-800" />
                <div className="h-2.5 w-16 rounded bg-zinc-100 dark:bg-zinc-800" />
              </div>
            </div>
          ))}
        </div>
      ) : recent.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-100 dark:bg-zinc-800">
            <AiSparklesIcon size={20} className="h-5 w-5 text-zinc-400" />
          </div>
          <div>
            <p className="text-xs font-bold text-zinc-700 dark:text-zinc-200">
              No conversations yet
            </p>
            <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
              Start chatting with your AI Assistant.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          {recent.map((conversation, index) => (
            <motion.div
              key={conversation.id}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.25, delay: index * 0.05 }}
              className="flex items-start gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
            >
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-950/50 dark:text-brand-400">
                <AiSparklesIcon size={15} className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-zinc-800 dark:text-zinc-100">
                  {conversationTitle(conversation)}
                </p>
                <p className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-500">
                  {formatRelativeTime(conversation.metadata.updatedAt)}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
};
