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
   * - Google OAuth + bot-token platforms: optimistic "disconnecting" → API
   *   call → "not-connected" on success, rollback on failure.
   * - Mock/placeholder platforms: immediate "not-connected".
   *
   * Every UI component must call this instead of implementing its own logic.
   */
  disconnectPlatform: (platformId: string) => Promise<void>;

  /** Open the bot-token connect dialog for a platform. */
  openConnectDialog: (platformId: string) => void;

  /** Close the bot-token connect dialog. */
  closeConnectDialog: () => void;

  /** Platform awaiting a bot token in the connect dialog (null when closed). */
  connectDialogPlatform: string | null;

  /**
   * POST a bot token for a bot-token platform, then refetch integration status.
   * Throws with the server's error message on failure (the dialog shows it).
   */
  connectWithToken: (platformId: string, token: string) => Promise<void>;

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

/**
 * API route segment per OAuth platform (the single source of truth for which
 * platforms are OAuth-based). Google platforms share the google-* routes;
 * GitHub and Discord each have their own connect/disconnect routes.
 */
const OAUTH_ROUTES: Record<string, { connect: string; disconnect: string }> = {
  gmail: { connect: "google-connect", disconnect: "google-disconnect" },
  "google-calendar": {
    connect: "google-connect",
    disconnect: "google-disconnect",
  },
  "google-drive": {
    connect: "google-connect",
    disconnect: "google-disconnect",
  },
  github: { connect: "github-connect", disconnect: "github-disconnect" },
  discord: { connect: "discord-connect", disconnect: "discord-disconnect" },
};

/**
 * OAuth platforms that show a confirmation dialog before the browser redirect.
 * The user reads an explanation of the OAuth flow and permissions, then clicks
 * "Continue" to trigger the redirect. Currently only Discord; GitHub and Google
 * platforms may be added here in the future.
 *
 * These platforms are still in OAUTH_ROUTES (they use OAuth redirects), but
 * instead of redirecting immediately on connectPlatform(), they open the shared
 * OAuthConnectDialog first.
 */
export const OAUTH_CONFIRM_ROUTES: Record<
  string,
  { connect: string; disconnect: string }
> = {
  discord: { connect: "discord-connect", disconnect: "discord-disconnect" },
};

/**
 * API route segment per bot-token platform (the single source of truth for
 * which platforms use a paste-a-token flow instead of OAuth). Telegram is the
 * first bot-token platform; future providers only add an entry here and reuse
 * the shared connect dialog (components/integrations/BotTokenConnectDialog).
 */
const BOT_TOKEN_ROUTES: Record<
  string,
  { connect: string; disconnect: string }
> = {
  telegram: { connect: "telegram-connect", disconnect: "telegram-disconnect" },
};

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

/**
 * Determine whether a platform uses server-side OAuth, which requires a
 * browser redirect through the provider's consent screen.
 */
function isOAuthPlatform(platformId: string): boolean {
  return Object.hasOwn(OAUTH_ROUTES, platformId);
}

/**
 * Determine whether a platform uses OAuth with a confirmation dialog before
 * the browser redirect. These platforms open the shared OAuthConnectDialog.
 */
function isOAuthConfirmPlatform(platformId: string): boolean {
  return Object.hasOwn(OAUTH_CONFIRM_ROUTES, platformId);
}

/**
 * Determine whether a platform uses a bot token (paste-a-token flow) instead
 * of OAuth. These platforms open the shared bot-token connect dialog.
 */
function isBotTokenPlatform(platformId: string): boolean {
  return Object.hasOwn(BOT_TOKEN_ROUTES, platformId);
}

/**
 * Build the OAuth redirect URL for a platform.
 */
function buildConnectUrl(platformId: string, currentPath: string): string {
  const next = encodeURIComponent(currentPath);
  const route = OAUTH_ROUTES[platformId]?.connect ?? "google-connect";
  return `/api/integrations/${route}?platform=${platformId}&next=${next}`;
}

/**
 * Build the OAuth disconnect URL for a platform.
 */
function buildDisconnectUrl(platformId: string): string {
  const route =
    OAUTH_ROUTES[platformId]?.disconnect ??
    BOT_TOKEN_ROUTES[platformId]?.disconnect ??
    "google-disconnect";
  return `/api/integrations/${route}?platform=${platformId}`;
}

// ──────────────────────────────────────────────
//  Context
// ──────────────────────────────────────────────

const IntegrationStoreContext = createContext<IntegrationStoreValue | null>(
  null,
);

// ──────────────────────────────────────────────
//  Provider
// ──────────────────────────────────────────────

interface IntegrationStoreProviderProps {
  children: ReactNode;
}

export function IntegrationStoreProvider({
  children,
}: IntegrationStoreProviderProps) {
  // Lazy initializer captures the static config once at mount (avoids reading a ref during render)
  const [platforms, setPlatforms] = useState<IntegrationConfig[]>(() => [
    ...defaultPlatforms,
  ]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // Bot-token connect dialog state — generic, reused by every bot-token platform
  const [connectDialogPlatform, setConnectDialogPlatform] = useState<
    string | null
  >(null);

  // Clean up connect timeout on unmount
  useEffect(() => () => clearTimeout(connectTimerRef.current), []);

  // ─── Data fetching ──────────────────────────

  const fetchIntegrations = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations");
      // Clear any previous error after the request has started (async), so no
      // synchronous setState runs inside the mount effect.
      setError(null);
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json"))
        throw new Error("Non-JSON response");
      const body = await res.json();
      if (body?.data && Array.isArray(body.data)) {
        setPlatforms(body.data);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to fetch integration status",
        );
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
    // The react-hooks rule cannot model awaits inside fetchIntegrations; the
    // fetch is async and all setState runs in promise continuations.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  // ─── Bot-token connect dialog actions ───────

  const openConnectDialog = useCallback((platformId: string) => {
    setConnectDialogPlatform(platformId);
  }, []);

  const closeConnectDialog = useCallback(() => {
    setConnectDialogPlatform(null);
  }, []);

  // ─── Shared connect action ──────────────────

  const connectPlatform = useCallback(
    (platformId: string) => {
      // Check current status BEFORE taking action
      // This is the single point of truth for the connect guard.
      const current = getIntegration(platformId);
      const alreadyConnected =
        current?.status === "connected" || current?.status === "syncing";

      if (alreadyConnected) {
        // Already connected — do nothing. The UI should not show Connect,
        // but this guard prevents race conditions and stale-state bugs.
        return;
      }

      if (isOAuthConfirmPlatform(platformId)) {
        // OAuth platforms with confirmation dialog: open the dialog instead of
        // redirecting immediately. The dialog explains the flow and permissions;
        // when the user clicks "Continue with Discord", it calls
        // connectPlatform() again — but this time the platform is intercepted
        // by the OAuth branch below (isOAuthConfirmPlatform is false because
        // the dialog is already open), so the redirect fires.
        openConnectDialog(platformId);
        return;
      }

      if (isOAuthPlatform(platformId)) {
        // OAuth platforms (Google/GitHub/Discord-after-confirmation): redirect
        // the browser — the callback will redirect back and the store refetches
        // status. Only redirect when status is not-connected (confirmed above).
        window.location.href = buildConnectUrl(
          platformId,
          window.location.pathname,
        );
        return;
      }

      if (isBotTokenPlatform(platformId)) {
        // Bot-token (e.g. Telegram) platforms: no OAuth redirect — open the
        // shared connect dialog. The dialog then drives the flow (paste token).
        openConnectDialog(platformId);
        return;
      }

      // Mock platforms: two-phase optimistic update
      updateIntegration(platformId, {
        status: "connecting" as ConnectionStatus,
      });
      clearTimeout(connectTimerRef.current);
      connectTimerRef.current = setTimeout(() => {
        updateIntegration(platformId, {
          status: "connected" as ConnectionStatus,
        });
      }, MOCK_CONNECT_DELAY);
    },
    [getIntegration, updateIntegration, openConnectDialog],
  );

  /**
   * POST a bot token for a bot-token platform and refetch on success.
   * The connect route owns validation (required + provider getMe check).
   */
  const connectWithToken = useCallback(
    async (platformId: string, token: string) => {
      const route = BOT_TOKEN_ROUTES[platformId]?.connect;
      const cleanToken = token.trim();
      if (!route)
        throw new Error(`No connect route configured for ${platformId}`);
      if (!cleanToken) throw new Error("Bot token is required");

      // Optimistic: surface "connecting" while the token is validated
      const previousStatus =
        getIntegration(platformId)?.status ?? "not-connected";
      updateIntegration(platformId, {
        status: "connecting" as ConnectionStatus,
      });

      try {
        const res = await fetch(`/api/integrations/${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ token: cleanToken }),
        });
        const body = await res.json().catch(() => null);

        if (!res.ok) {
          // Restore the prior status and surface the server message
          updateIntegration(platformId, {
            status: previousStatus as ConnectionStatus,
          });
          const message =
            body?.message ??
            body?.errors?.[0]?.message ??
            `Failed to connect (${res.status})`;
          throw new Error(message);
        }

        // Server accepted the token — mark connected optimistically first so a
        // failed refetch can never leave the badge stuck on "connecting".
        updateIntegration(platformId, {
          status: "connected" as ConnectionStatus,
        });
        await fetchIntegrations();
        closeConnectDialog();
      } catch (err) {
        // Restore the prior status (not-connected / token-expired / …)
        updateIntegration(platformId, {
          status: previousStatus as ConnectionStatus,
        });
        throw err;
      }
    },
    [fetchIntegrations, updateIntegration, closeConnectDialog, getIntegration],
  );

  // ─── Shared disconnect action ───────────────

  const disconnectPlatform = useCallback(
    async (platformId: string) => {
      // Mock platforms: immediate optimistic update (no server request)
      if (!isOAuthPlatform(platformId) && !isBotTokenPlatform(platformId)) {
        updateIntegration(platformId, {
          status: "not-connected" as ConnectionStatus,
        });
        return;
      }

      const prev = snapshot();

      // Optimistic: briefly show "disconnecting" before transitioning to
      // "not-connected", then call the disconnect route. The returned promise
      // settles only after the API responds, so callers (e.g. the confirmation
      // dialog) can await it and surface failures.
      updateIntegration(platformId, {
        status: "disconnecting" as ConnectionStatus,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      updateIntegration(platformId, {
        status: "not-connected" as ConnectionStatus,
      });

      try {
        const res = await fetch(buildDisconnectUrl(platformId), {
          method: "GET",
          credentials: "same-origin",
        });
        if (!res.ok) {
          // Rollback on failure
          replacePlatforms(prev);
          const body = await res.json().catch(() => null);
          throw new Error(
            body?.message ??
              `Failed to disconnect ${platformId} (${res.status})`,
          );
        }
      } catch (err) {
        // Rollback on error, then rethrow so the caller can show the error
        replacePlatforms(prev);
        throw err instanceof Error
          ? err
          : new Error(`Failed to disconnect ${platformId}`);
      }
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
    openConnectDialog,
    closeConnectDialog,
    connectDialogPlatform,
    connectWithToken,
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
