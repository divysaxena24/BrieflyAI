"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import type { IntegrationConfig, ConnectionStatus } from "./types";
import { integrationPlatforms as defaultPlatforms } from "./config";

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

interface IntegrationStoreValue {
  /** All platforms with merged server state */
  platforms: IntegrationConfig[];
  /** True while the initial fetch is in flight */
  isLoading: boolean;
  /** Non-null when the last fetch failed */
  error: string | null;

  /** Lookup a single integration by its id (e.g. "gmail") */
  getIntegration: (id: string) => IntegrationConfig | undefined;

  /**
   * Shared connect action.
   *
   * - Google OAuth platforms: redirects the browser to the OAuth flow.
   * - Mock/placeholder platforms: two-phase optimistic update
   *   (connecting → 300ms → connected).
   *
   * Every UI component must call this instead of implementing its own logic.
   */
  connectPlatform: (platformId: string) => void;

  /**
   * Shared disconnect action.
   *
   * - Google OAuth platforms: optimistic "disconnecting" → API call →
   *   "not-connected" on success, rollback on failure.
   * - Mock/placeholder platforms: immediate "not-connected".
   *
   * Every UI component must call this instead of implementing its own logic.
   */
  disconnectPlatform: (platformId: string) => Promise<void>;

  /**
   * Optimistically update a single integration's fields.
   * Prefer connectPlatform / disconnectPlatform for standard operations.
   */
  updateIntegration: (id: string, updates: Partial<IntegrationConfig>) => void;

  /** Replace the entire platforms array (used for rollback). */
  replacePlatforms: (platforms: IntegrationConfig[]) => void;

  /** Refetch integration status from the server and merge into state. */
  refetch: () => Promise<void>;

  /** Snapshot the current platforms so callers can roll back on error. */
  snapshot: () => IntegrationConfig[];
}

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

const MOCK_CONNECT_DELAY = 300;

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

/**
 * Determine whether a platform uses server-side OAuth (Google or GitHub),
 * which requires a browser redirect through the provider's consent screen.
 */
function isOAuthPlatform(platformId: string): boolean {
  return ["gmail", "google-calendar", "google-drive", "github"].includes(platformId);
}

/**
 * Build the OAuth redirect URL for a platform.
 */
function buildConnectUrl(platformId: string, currentPath: string): string {
  const next = encodeURIComponent(currentPath);
  const route = platformId === "github" ? "github-connect" : "google-connect";
  return `/api/integrations/${route}?platform=${platformId}&next=${next}`;
}

/**
 * Build the OAuth disconnect URL for a platform.
 */
function buildDisconnectUrl(platformId: string): string {
  const route = platformId === "github" ? "github-disconnect" : "google-disconnect";
  return `/api/integrations/${route}?platform=${platformId}`;
}

// ──────────────────────────────────────────────
//  Context
// ──────────────────────────────────────────────

const IntegrationStoreContext = createContext<IntegrationStoreValue | null>(null);

// ──────────────────────────────────────────────
//  Provider
// ──────────────────────────────────────────────

interface IntegrationStoreProviderProps {
  children: ReactNode;
}

export function IntegrationStoreProvider({ children }: IntegrationStoreProviderProps) {
  const initial = useRef([...defaultPlatforms]).current;

  const [platforms, setPlatforms] = useState<IntegrationConfig[]>(initial);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Clean up connect timeout on unmount
  useEffect(() => () => clearTimeout(connectTimerRef.current), []);

  // ─── Data fetching ──────────────────────────

  const fetchIntegrations = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/integrations");
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) throw new Error("Non-JSON response");
      const body = await res.json();
      if (body?.data && Array.isArray(body.data)) {
        setPlatforms(body.data);
      }
    } catch (err: any) {
      if (mountedRef.current) {
        setError(err?.message ?? "Failed to fetch integration status");
      }
    } finally {
      if (mountedRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  // Fetch on mount
  useEffect(() => {
    mountedRef.current = true;
    fetchIntegrations();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchIntegrations]);

  // ─── State mutation helpers ─────────────────

  const updateIntegration = useCallback(
    (id: string, updates: Partial<IntegrationConfig>) => {
      setPlatforms((prev) =>
        prev.map((p) => (p.id === id ? { ...p, ...updates } : p)),
      );
    },
    [],
  );

  const replacePlatforms = useCallback((newPlatforms: IntegrationConfig[]) => {
    setPlatforms(newPlatforms);
  }, []);

  const snapshot = useCallback(() => [...platforms], [platforms]);

  const getIntegration = useCallback(
    (id: string) => platforms.find((p) => p.id === id),
    [platforms],
  );

  // ─── Shared connect action ──────────────────

  const connectPlatform = useCallback(
    (platformId: string) => {
      // Check current status BEFORE taking action
      // This is the single point of truth for the connect guard.
      const current = getIntegration(platformId);
      const alreadyConnected = current?.status === "connected" || current?.status === "syncing";

      if (alreadyConnected) {
        // Already connected — do nothing. The UI should not show Connect,
        // but this guard prevents race conditions and stale-state bugs.
        return;
      }

      if (isOAuthPlatform(platformId)) {
        // OAuth platforms (Google/GitHub): redirect the browser — the callback will
        // redirect back and the store refetches status. Only redirect when status
        // is not-connected (confirmed above).
        window.location.href = buildConnectUrl(platformId, window.location.pathname);
        return;
      }

      // Mock platforms: two-phase optimistic update
      updateIntegration(platformId, { status: "connecting" as ConnectionStatus });
      clearTimeout(connectTimerRef.current);
      connectTimerRef.current = setTimeout(() => {
        updateIntegration(platformId, { status: "connected" as ConnectionStatus });
      }, MOCK_CONNECT_DELAY);
    },
    [getIntegration, updateIntegration],
  );

  // ─── Shared disconnect action ───────────────

  const disconnectPlatform = useCallback(
    async (platformId: string) => {
      if (isOAuthPlatform(platformId)) {
        const prev = snapshot();

        // Optimistic: show "disconnecting" then "not-connected"
        updateIntegration(platformId, { status: "disconnecting" as ConnectionStatus });
        // Briefly show disconnecting before transitioning to not-connected
        clearTimeout(connectTimerRef.current);
        connectTimerRef.current = setTimeout(async () => {
          updateIntegration(platformId, { status: "not-connected" as ConnectionStatus });

          try {
            const res = await fetch(buildDisconnectUrl(platformId), {
              method: "GET",
              credentials: "same-origin",
            });
            if (!res.ok) {
              // Rollback on failure
              replacePlatforms(prev);
              console.error(`Failed to disconnect ${platformId}`);
            }
          } catch (err) {
            // Rollback on error
            replacePlatforms(prev);
            console.error(err);
          }
        }, 200);
        return;
      }

      // Mock platforms: immediate optimistic update
      updateIntegration(platformId, { status: "not-connected" as ConnectionStatus });
    },
    [updateIntegration, snapshot, replacePlatforms],
  );

  // ─── Context value ──────────────────────────

  const value: IntegrationStoreValue = {
    platforms,
    isLoading,
    error,
    getIntegration,
    connectPlatform,
    disconnectPlatform,
    updateIntegration,
    replacePlatforms,
    refetch: fetchIntegrations,
    snapshot,
  };

  return (
    <IntegrationStoreContext.Provider value={value}>
      {children}
    </IntegrationStoreContext.Provider>
  );
}

// ──────────────────────────────────────────────
//  Hook
// ──────────────────────────────────────────────

export function useIntegrationStatus(): IntegrationStoreValue {
  const ctx = useContext(IntegrationStoreContext);
  if (!ctx) {
    throw new Error(
      "useIntegrationStatus must be used within an <IntegrationStoreProvider>. " +
        "Wrap your dashboard layout with <IntegrationStoreProvider>.",
    );
  }
  return ctx;
}
