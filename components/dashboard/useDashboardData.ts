"use client";

import { useEffect, useState } from "react";

/** Shape of an entry returned by GET /api/activity. */
export interface ActivityEntry {
  id: string;
  platformId: string;
  action: string;
  details: string | null;
  type: string;
  createdAt: string;
}

/** Minimal shape of a conversation returned by GET /api/conversations. */
export interface DashboardConversation {
  id: string;
  metadata: { title?: string; createdAt: string; updatedAt: string };
  messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
}

export interface DashboardData {
  /** Real activity entries (empty when none or on error). */
  activities: ActivityEntry[];
  /** Real conversations (empty when none or on error). */
  conversations: DashboardConversation[];
  /** True while the initial fetch is in flight. */
  loading: boolean;
}

/** A single in-flight request shared by every consumer on the page. */
let inFlight: Promise<{ activities: ActivityEntry[]; conversations: DashboardConversation[] }> | null = null;

function fetchAll() {
  if (!inFlight) {
    inFlight = Promise.all([
      fetch("/api/activity").then((res) => (res.ok ? res.json() : null)),
      fetch("/api/conversations").then((res) => (res.ok ? res.json() : null)),
    ])
      .then(([activityBody, conversationBody]) => ({
        activities: Array.isArray(activityBody?.data) ? activityBody.data : [],
        conversations: Array.isArray(conversationBody?.data) ? conversationBody.data : [],
      }))
      .catch(() => ({ activities: [], conversations: [] }))
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * Fetch real dashboard data (activity + conversations) for the Overview,
 * Recent Conversations, Activity Timeline, and Getting Started sections.
 * Concurrent consumers share a single request; each still gets its own state.
 */
export function useDashboardData(): DashboardData {
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [conversations, setConversations] = useState<DashboardConversation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchAll()
      .then((data) => {
        if (cancelled) return;
        setActivities(data.activities);
        setConversations(data.conversations);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { activities, conversations, loading };
}
