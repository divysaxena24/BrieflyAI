"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangleIcon, Loader2Icon } from "@/components/dashboard/icons";

// ──────────────────────────────────────────────────────────────
//  Reusable confirmation dialog
//
//  The single source of truth for every destructive action in the
//  app (disconnect integration, logout, delete session, …). Callers
//  either use the global `useConfirmAction()` hook (recommended —
//  zero state management) or render `<ConfirmationDialog>` directly.
//
//  Behavior contract:
//    • The destructive action ONLY runs after the user clicks the
//      red primary button.
//    • Clicking the backdrop never triggers the action (inert).
//    • ESC / Cancel close the dialog without acting.
//    • While the request runs, the primary button shows a loading
//      state and duplicate clicks are ignored.
//    • The dialog closes only after `onConfirm` resolves.
//    • If `onConfirm` rejects, the dialog stays open and shows the
//      error so the user can retry or cancel.
// ──────────────────────────────────────────────────────────────

export interface ConfirmationDialogProps {
  /** Controls visibility (controlled). */
  open: boolean;
  /** Dialog title. Defaults to "Are you sure?". */
  title?: string;
  /** Body copy explaining the consequence of the action. */
  message: ReactNode;
  /** Label of the destructive primary button ("Disconnect", "Logout", "Delete", …). */
  confirmLabel: string;
  /** Label shown on the primary button while the request is running. */
  busyLabel?: string;
  /** Label of the secondary button. Defaults to "Cancel". */
  cancelLabel?: string;
  /**
   * The destructive action. Runs only after explicit confirmation.
   * Must reject when the underlying API call fails so the dialog can
   * stay open and display the error.
   */
  onConfirm: () => void | Promise<void>;
  /** Fired when the dialog closes WITHOUT confirming (Cancel / ESC). */
  onCancel: () => void;
  /** Optional — fired once after `onConfirm` resolves, before closing. */
  onSuccess?: () => void;
}

export const ConfirmationDialog: React.FC<ConfirmationDialogProps> = ({
  open,
  title = "Are you sure?",
  message,
  confirmLabel,
  busyLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  onSuccess,
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  const handleConfirm = useCallback(async () => {
    // Prevent duplicate clicks while the request is running.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      // Close only after a successful response.
      onSuccess?.();
      onCancel();
    } catch (err) {
      // Keep the dialog open and surface the failure.
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again.",
      );
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [onConfirm, onSuccess, onCancel]);

  const handleCancel = useCallback(() => {
    if (submittingRef.current) return;
    onCancel();
  }, [onCancel]);

  // ESC cancels the dialog — but never while a request is running.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, handleCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirmation-dialog-title"
      aria-describedby="confirmation-dialog-message"
    >
      {/*
        Backdrop — deliberately inert. Clicking outside the modal must
        NEVER perform (or dismiss) a destructive action; only ESC or the
        explicit Cancel button may abort it.
      */}
      <div
        className="absolute inset-0 bg-zinc-950/60 backdrop-blur-sm"
        aria-hidden="true"
      />

      {/* Dialog card */}
      <div className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        <div className="p-6">
          {/* Header */}
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-100 dark:bg-red-950/60">
              <AlertTriangleIcon
                size={20}
                className="h-5 w-5 text-red-600 dark:text-red-400"
              />
            </div>
            <div className="min-w-0 flex-1">
              <h2
                id="confirmation-dialog-title"
                className="text-base font-bold text-zinc-900 dark:text-white"
              >
                {title}
              </h2>
            </div>
          </div>

          {/* Message */}
          <div
            id="confirmation-dialog-message"
            className="mt-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400"
          >
            {message}
          </div>

          {/* Error — the dialog stays open and shows this on API failure */}
          {error && (
            <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-600 dark:bg-red-950/40 dark:text-red-400">
              <AlertTriangleIcon size={13} className="h-3 w-3 shrink-0" />
              {error}
            </p>
          )}

          {/* Actions */}
          <div className="mt-5 flex items-center justify-end gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
            <button
              type="button"
              onClick={handleCancel}
              disabled={isSubmitting}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-2 text-xs font-semibold text-zinc-600 transition-all hover:bg-zinc-50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={isSubmitting}
              className="inline-flex items-center gap-1.5 rounded-xl bg-red-600 px-4 py-2 text-xs font-bold text-white shadow-sm transition-all hover:bg-red-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? (
                <>
                  <Loader2Icon size={14} className="h-3.5 w-3.5 animate-spin" />
                  {busyLabel ?? `${confirmLabel}…`}
                </>
              ) : (
                confirmLabel
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────
//  Global wiring — mount <ConfirmationProvider> once (e.g. in the
//  root layout) and call `useConfirmAction()` from any page or
//  component. Future destructive actions get confirmation for free
//  with zero per-page state or duplicated dialog markup.
// ──────────────────────────────────────────────────────────────

/**
 * True when a server action (e.g. `signOut`) rejected because it called
 * `redirect()` — navigation is in progress and the rejection is expected.
 * Next.js throws an error carrying a `NEXT_REDIRECT` digest on the server;
 * on the client it may surface as an Error message or a `digest` field.
 */
export function isRedirectError(err: unknown): boolean {
  if (err instanceof Error && err.message.includes("NEXT_REDIRECT")) return true;
  if (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { digest?: unknown }).digest === "string"
  ) {
    return (err as { digest: string }).digest.includes("NEXT_REDIRECT");
  }
  return false;
}

export interface ConfirmActionOptions {
  title?: string;
  message: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
}

interface PendingConfirmation extends ConfirmActionOptions {
  id: number;
  resolve: (confirmed: boolean) => void;
}

type ConfirmAction = (options: ConfirmActionOptions) => Promise<boolean>;

const ConfirmationContext = createContext<ConfirmAction | null>(null);

export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const idRef = useRef(0);

  const closeDialog = useCallback((confirmed: boolean) => {
    setPending((current) => {
      // Resolve the awaiting promise exactly once (a no-op if the dialog
      // was already closed by onSuccess).
      current?.resolve(confirmed);
      return null;
    });
  }, []);

  const confirmAction = useCallback((options: ConfirmActionOptions) => {
    idRef.current += 1;
    const id = idRef.current;
    return new Promise<boolean>((resolve) => {
      // If a confirmation is already open, dismiss it first (resolve false)
      // so its promise never hangs, then show the new one.
      setPending((current) => {
        current?.resolve(false);
        return { ...options, id, resolve };
      });
    });
  }, []);

  return (
    <ConfirmationContext.Provider value={confirmAction}>
      {children}
      {pending && (
        <ConfirmationDialog
          key={pending.id}
          open
          title={pending.title}
          message={pending.message}
          confirmLabel={pending.confirmLabel}
          busyLabel={pending.busyLabel}
          cancelLabel={pending.cancelLabel}
          onConfirm={pending.onConfirm}
          onCancel={() => closeDialog(false)}
          onSuccess={() => closeDialog(true)}
        />
      )}
    </ConfirmationContext.Provider>
  );
}

/**
 * Returns a `confirmAction(options)` function. Calling it opens the
 * global confirmation dialog; the returned promise resolves with
 * `true` once the destructive action succeeded and `false` when the
 * user cancelled.
 */
export function useConfirmAction(): ConfirmAction {
  const ctx = useContext(ConfirmationContext);
  if (!ctx) {
    throw new Error(
      "useConfirmAction must be used within a <ConfirmationProvider>. " +
        "Wrap your root layout with <ConfirmationProvider>.",
    );
  }
  return ctx;
}
