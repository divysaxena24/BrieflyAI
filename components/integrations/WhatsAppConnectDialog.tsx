"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { useIntegrationStatus } from "@/lib/integrations/store";
import { useConfirmAction } from "@/components/ConfirmationDialog";
import { PlatformIcon } from "./PlatformIcon";
import {
  Loader2Icon,
  AlertTriangleIcon,
  CheckCircleIcon,
  RefreshCwIcon,
  WifiOffIcon,
} from "@/components/dashboard/icons";

/**
 * Shared connect dialog for pairing-code platforms (the first is WhatsApp).
 *
 * Any platform registered in the store's PAIRING_CODE_ROUTES mapping opens
 * this dialog when Connect is clicked. The flow is QR-based, not token-based:
 *
 *   1. POST  /api/integrations/whatsapp-connect   (store.connectWithPairing)
 *   2. Poll  /api/integrations/whatsapp-qr        every 2s  → raw QR string
 *   3. Poll  /api/integrations/whatsapp-status    every 2s  → { status, sessionState }
 *   4. Render the QR client-side with the `qrcode` library
 *   5. On status "connected" → refetch() + close dialog
 *
 * All session/polling logic lives here; the store owns the API calls and the
 * shared optimistic updates. Form/state is remounted via `key` on open.
 */
export const WhatsAppConnectDialog: React.FC = () => {
  const { connectDialogPlatform, getIntegration } = useIntegrationStatus();
  // Render only for pairing-code platforms — bot-token platforms (e.g.
  // Telegram) are handled by the BotTokenConnectDialog.
  if (!connectDialogPlatform) return null;
  if (getIntegration(connectDialogPlatform)?.authenticationType !== "pairing-code") return null;
  return <WhatsAppConnectDialogInner key={connectDialogPlatform} platformId={connectDialogPlatform} />;
};

interface WhatsAppConnectDialogInnerProps {
  platformId: string;
}

type DialogPhase =
  | "starting" // POST connect in flight
  | "waiting-qr" // session started, no QR issued yet
  | "qr-ready" // QR displayed, awaiting scan
  | "connecting" // QR scanned / auto-reconnect in progress
  | "connected" // success — closing
  | "reconnect-required" // auto-reconnect gave up
  | "expired" // connection timed out
  | "disconnected" // session logged out
  | "error"; // session creation failed

const POLL_INTERVAL_MS = 2_000;
const CONNECT_TIMEOUT_MS = 120_000;
const CONNECTED_DISMISS_MS = 700;
const QR_SIZE = 220;

const WhatsAppConnectDialogInner: React.FC<WhatsAppConnectDialogInnerProps> = ({ platformId }) => {
  const { getIntegration, closeConnectDialog, refetch, connectWithPairing, regeneratePairingSession } =
    useIntegrationStatus();
  const confirmAction = useConfirmAction();
  const integration = getIntegration(platformId);

  const [phase, setPhase] = useState<DialogPhase>("starting");
  const [qr, setQr] = useState<string | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollInFlightRef = useRef(false);
  // Set on every startPolling() — never read before that (avoids Date.now in render)
  const startedAtRef = useRef<number>(0);
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once the scan succeeded — used to restore the badge on cancel
  const connectedRef = useRef(false);

  // ── Polling lifecycle ───────────────────────

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  /** Single poll tick: fetch QR + status in parallel, then transition phase. */
  const poll = useCallback(async () => {
    if (pollInFlightRef.current || !mountedRef.current) return;
    pollInFlightRef.current = true;
    try {
      const [qrRes, statusRes] = await Promise.all([
        fetch("/api/integrations/whatsapp-qr", { credentials: "same-origin" }),
        fetch("/api/integrations/whatsapp-status", { credentials: "same-origin" }),
      ]);
      const [qrBody, statusBody] = await Promise.all([
        qrRes.ok ? qrRes.json().catch(() => null) : null,
        statusRes.ok ? statusRes.json().catch(() => null) : null,
      ]);

      if (!mountedRef.current) return;

      const nextQr: string | null = qrBody?.data?.qr ?? null;
      const status: string | null = statusBody?.data?.status ?? null;
      const sessionState: string | null = statusBody?.data?.sessionState ?? null;
      const lastDisconnectReason: string | null = statusBody?.data?.lastDisconnectReason ?? null;

      // Successful poll — clear any transient network error banner
      setError(null);

      // 1. Connected — done
      if (status === "connected" || sessionState === "open") {
        connectedRef.current = true;
        setPhase("connected");
        stopPolling();
        return;
      }

      // 2. Auto-reconnect gave up — offer a fresh QR
      if (lastDisconnectReason === "reconnect-failed" || status === "error") {
        setPhase("reconnect-required");
        stopPolling();
        return;
      }

      // 3. Logged out — re-scan required
      if (sessionState === "logged-out" || status === "not-connected") {
        setPhase("disconnected");
        stopPolling();
        return;
      }

      // 4. QR available — display it
      if (nextQr) {
        setQr(nextQr);
        setPhase("qr-ready");
        return;
      }

      // 5. Session connecting (scan received or auto-reconnect in progress)
      if (status === "connecting") {
        setPhase("connecting");
        return;
      }

      // 6. Still waiting for a QR to be issued
      setPhase("waiting-qr");
    } catch {
      // Network failure — keep polling on the next tick (retry)
      if (mountedRef.current) {
        setError("Network error — retrying…");
      }
    } finally {
      pollInFlightRef.current = false;
    }
  }, [stopPolling]);

  /** Start polling, reseting the connection-timeout clock. */
  const startPolling = useCallback(() => {
    stopPolling();
    startedAtRef.current = Date.now();
    pollTimerRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);
    void poll();
  }, [poll, stopPolling]);

  /** Connection timeout: QR never scanned within the window. */
  const startTimeout = useCallback(() => {
    if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
    connectTimerRef.current = setTimeout(() => {
      // Never clobber a terminal phase (connected / reconnect-required /
      // disconnected / error) — those stop polling first, which clears the
      // interval and makes this check bail.
      if (!mountedRef.current || pollTimerRef.current === null) return;
      setPhase("expired");
      stopPolling();
    }, CONNECT_TIMEOUT_MS);
  }, [stopPolling]);

  // ── Session lifecycle ───────────────────────

  /** POST the connect route and begin polling QR + status. */
  const startSession = useCallback(async () => {
    setPhase("starting");
    setError(null);
    setQr(null);
    setQrImage(null);
    try {
      await connectWithPairing(platformId);
      if (!mountedRef.current) return;
      setPhase("waiting-qr");
      startPolling();
      startTimeout();
    } catch (err) {
      if (!mountedRef.current) return;
      setPhase("error");
      setError(err instanceof Error ? err.message : "Failed to start the WhatsApp session.");
    }
  }, [platformId, connectWithPairing, startPolling, startTimeout]);

  /** Restart from a fresh session after auto-reconnect gave up. */
  const regenerate = useCallback(async () => {
    // Session reset clears the current WhatsApp session server-side (the
    // disconnect route) before issuing a new QR — destructive, so it requires
    // explicit confirmation. On failure the confirmation dialog stays open
    // with the error; on cancel nothing happens.
    const confirmed = await confirmAction({
      title: "Are you sure?",
      message:
        "This will clear the current WhatsApp session and issue a new QR code. You'll need to scan the new code to reconnect.",
      confirmLabel: "Reset Session",
      busyLabel: "Resetting…",
      onConfirm: () => regeneratePairingSession(platformId),
    });
    if (!confirmed || !mountedRef.current) return;

    setError(null);
    setQr(null);
    setQrImage(null);
    setPhase("waiting-qr");
    startPolling();
    startTimeout();
  }, [platformId, confirmAction, regeneratePairingSession, startPolling, startTimeout]);

  /** Retry the whole flow (timeout / network failure). */
  const retry = useCallback(() => {
    void startSession();
  }, [startSession]);

  /** Success: sync server state then dismiss. */
  const handleConnected = useCallback(async () => {
    await refetch();
    if (!mountedRef.current) return;
    connectTimerRef.current = setTimeout(() => closeConnectDialog(), CONNECTED_DISMISS_MS);
  }, [refetch, closeConnectDialog]);

  // ── Mount / effects ─────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    // startSession is async — all setState runs in promise continuations.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void startSession();
    return () => {
      mountedRef.current = false;
      stopPolling();
      if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      // If the user cancelled before the scan completed, restore the badge to
      // the server's truth (the optimistic "connecting" would otherwise stick).
      if (!connectedRef.current) {
        void refetch();
      }
    };
    // Run exactly once per mount — the dialog is remounted via `key` whenever
    // it opens. `startSession`'s identity changes every time the store's
    // platforms array updates (connectWithPairing → getIntegration depends on
    // platforms), so depending on it here would re-run this effect on every
    // update: the cleanup calls refetch() while the re-run calls startSession()
    // again → connectWithPairing → setPlatforms → a new startSession identity
    // → re-run… an infinite "Maximum update depth exceeded" loop. The first
    // render's closures (stable startSession/stopPolling/refetch) are
    // sufficient and correct for the one-shot connect request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the phase flips to "connected", sync + close after a brief check.
  useEffect(() => {
    if (phase === "connected") {
      void handleConnected();
    }
  }, [phase, handleConnected]);

  // Render the raw QR string to a data-URL image client-side. The image is
  // cleared by startSession/regenerate — a null qr needs no sync setState here.
  useEffect(() => {
    if (!qr) return;
    let cancelled = false;
    QRCode.toDataURL(qr, {
      width: QR_SIZE,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#18181b", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setQrImage(url);
      })
      .catch(() => {
        if (!cancelled) setQrImage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [qr]);

  // Close on Escape — blocked while a session/connection is in progress so a
  // failed connect's error is never swallowed by an unmounted dialog.
  useEffect(() => {
    const busy = phase === "starting" || phase === "connecting";
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) closeConnectDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase, closeConnectDialog]);

  if (!integration) return null;

  const busy = phase === "starting" || phase === "connecting";

  // ── Body per phase ──────────────────────────

  const renderBody = () => {
    switch (phase) {
      case "starting":
        return (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <Loader2Icon size={22} className="h-6 w-6 animate-spin text-brand-600 dark:text-brand-400" />
            <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Starting session…</p>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              Preparing your WhatsApp connection…
            </p>
          </div>
        );

      case "waiting-qr":
        return (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <Loader2Icon size={22} className="h-6 w-6 animate-spin text-brand-600 dark:text-brand-400" />
            <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Waiting for QR…</p>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              The QR code will appear in a moment.
            </p>
          </div>
        );

      case "qr-ready":
        return (
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            <div className="rounded-2xl border border-zinc-200 bg-white p-3 shadow-inner dark:border-zinc-700">
              {qrImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qrImage}
                  alt="WhatsApp QR code"
                  width={QR_SIZE}
                  height={QR_SIZE}
                  className="h-[220px] w-[220px] rounded-lg"
                />
              ) : (
                <div className="flex h-[220px] w-[220px] items-center justify-center">
                  <Loader2Icon size={20} className="h-5 w-5 animate-spin text-zinc-400" />
                </div>
              )}
            </div>
            <div>
              <p className="text-sm font-bold text-zinc-900 dark:text-white">QR Ready</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                Open <strong>WhatsApp → Linked Devices → Link a Device</strong> and scan this code
                with your phone.
              </p>
            </div>
          </div>
        );

      case "connecting":
        return (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <Loader2Icon size={22} className="h-6 w-6 animate-spin text-amber-500" />
            <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Connecting…</p>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              Securing your WhatsApp connection…
            </p>
          </div>
        );

      case "connected":
        return (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950/60">
              <CheckCircleIcon size={24} className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <p className="text-sm font-bold text-zinc-900 dark:text-white">Connected!</p>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">WhatsApp is now linked to BrieflyAI.</p>
          </div>
        );

      case "reconnect-required":
        return (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950/60">
              <AlertTriangleIcon size={24} className="h-6 w-6 text-amber-600 dark:text-amber-400" />
            </div>
            <p className="text-sm font-bold text-zinc-900 dark:text-white">Reconnect Required</p>
            <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              Your WhatsApp connection was lost and could not be restored automatically. Generate a
              new QR code to re-link your device.
            </p>
            <button
              type="button"
              onClick={() => void regenerate()}
              className="mt-1 inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-xs font-bold text-white shadow-sm transition-all hover:bg-brand-500 active:scale-95"
            >
              <RefreshCwIcon size={14} className="h-3.5 w-3.5" />
              Generate New QR
            </button>
          </div>
        );

      case "expired":
        return (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-orange-100 dark:bg-orange-950/60">
              <WifiOffIcon size={24} className="h-6 w-6 text-orange-600 dark:text-orange-400" />
            </div>
            <p className="text-sm font-bold text-zinc-900 dark:text-white">Expired</p>
            <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              The connection timed out before the QR code could be scanned. You can retry to get a
              fresh code.
            </p>
            <button
              type="button"
              onClick={retry}
              className="mt-1 inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-xs font-bold text-white shadow-sm transition-all hover:bg-brand-500 active:scale-95"
            >
              <RefreshCwIcon size={14} className="h-3.5 w-3.5" />
              Retry
            </button>
          </div>
        );

      case "disconnected":
        return (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
              <WifiOffIcon size={24} className="h-6 w-6 text-zinc-500 dark:text-zinc-400" />
            </div>
            <p className="text-sm font-bold text-zinc-900 dark:text-white">Disconnected</p>
            <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              This WhatsApp session was logged out. Generate a new QR code to connect again.
            </p>
            <button
              type="button"
              onClick={() => void regenerate()}
              className="mt-1 inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-xs font-bold text-white shadow-sm transition-all hover:bg-brand-500 active:scale-95"
            >
              <RefreshCwIcon size={14} className="h-3.5 w-3.5" />
              Generate New QR
            </button>
          </div>
        );

      case "error":
        return (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-950/60">
              <AlertTriangleIcon size={24} className="h-6 w-6 text-red-600 dark:text-red-400" />
            </div>
            <p className="text-sm font-bold text-zinc-900 dark:text-white">Connection Failed</p>
            <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              {error ?? "Something went wrong while connecting WhatsApp."}
            </p>
            <button
              type="button"
              onClick={retry}
              className="mt-1 inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-xs font-bold text-white shadow-sm transition-all hover:bg-brand-500 active:scale-95"
            >
              <RefreshCwIcon size={14} className="h-3.5 w-3.5" />
              Retry
            </button>
          </div>
        );
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="whatsapp-dialog-title"
    >
      {/* Backdrop — closes the dialog except while a session/connection is busy */}
      <div
        className="absolute inset-0 bg-zinc-950/60 backdrop-blur-sm"
        onClick={busy ? undefined : closeConnectDialog}
        aria-hidden="true"
      />

      {/* Dialog card */}
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        {/* Accent bar */}
        <div
          className="absolute inset-x-0 top-0 h-1"
          style={{ backgroundColor: integration.accentColor }}
        />

        <div className="p-6">
          {/* Header */}
          <div className="mb-5 flex items-center gap-3">
            <div
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
              style={{ backgroundColor: `${integration.accentColor}18`, color: integration.accentColor }}
            >
              <PlatformIcon platformId={integration.id} size={22} />
            </div>
            <div className="min-w-0 flex-1">
              <h2
                id="whatsapp-dialog-title"
                className="text-base font-bold text-zinc-900 dark:text-white"
              >
                Connect {integration.name}
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Scan the QR code to link {integration.name}.
              </p>
            </div>
            {!busy && (
              <button
                type="button"
                onClick={closeConnectDialog}
                aria-label="Close"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-all hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          {/* Body */}
          {renderBody()}

          {/* Error banner (transient network failures during polling) */}
          {error && phase !== "error" && (
            <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-600 dark:bg-red-950/40 dark:text-red-400">
              <AlertTriangleIcon size={13} className="h-3 w-3 shrink-0" />
              {error}
            </p>
          )}

          {/* Footer */}
          <div className="mt-5 flex items-center justify-end gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
            <button
              type="button"
              onClick={closeConnectDialog}
              disabled={busy}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-2 text-xs font-semibold text-zinc-600 transition-all hover:bg-zinc-50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WhatsAppConnectDialog;
