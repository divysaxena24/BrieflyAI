"use client";

import React, { useEffect, useState } from "react";
import { useIntegrationStatus } from "@/lib/integrations/store";
import { PlatformIcon } from "./PlatformIcon";
import {
  Loader2Icon,
  LockIcon,
  AlertTriangleIcon,
  CheckCircleIcon,
} from "@/components/dashboard/icons";

/**
 * Shared connect dialog for bot-token platforms (the first is Telegram).
 *
 * Any platform registered in the store's BOT_TOKEN_ROUTES mapping opens this
 * dialog when Connect is clicked: the user pastes their bot token, which is
 * POSTed by the store's connectWithToken() and refetched on success — the
 * dialog holds no integration logic of its own.
 *
 * The form state lives in the inner component which is remounted via `key`
 * whenever the dialog opens, so the form is always fresh without reset effects.
 */
export const BotTokenConnectDialog: React.FC = () => {
  const { connectDialogPlatform, getIntegration } = useIntegrationStatus();
  // Render only for bot-token platforms — pairing-code platforms (e.g.
  // WhatsApp) are handled by the WhatsAppConnectDialog.
  if (!connectDialogPlatform) return null;
  if (getIntegration(connectDialogPlatform)?.authenticationType !== "bot-token") return null;
  return <BotTokenConnectDialogInner key={connectDialogPlatform} platformId={connectDialogPlatform} />;
};

interface BotTokenConnectDialogInnerProps {
  platformId: string;
}

const BotTokenConnectDialogInner: React.FC<BotTokenConnectDialogInnerProps> = ({ platformId }) => {
  const { getIntegration, closeConnectDialog, connectWithToken } = useIntegrationStatus();
  const integration = getIntegration(platformId);

  const [token, setToken] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape — blocked while submitting so a failed connect's error is
  // never swallowed by an unmounted dialog (listener callback only, no sync setState)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSubmitting) closeConnectDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeConnectDialog, isSubmitting]);

  if (!integration) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setError("Bot token is required.");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      // On success the store refetches status and closes the dialog
      await connectWithToken(platformId, token);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to connect. Check your token and try again.",
      );
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bot-token-dialog-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-zinc-950/60 backdrop-blur-sm"
        onClick={isSubmitting ? undefined : closeConnectDialog}
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
            <div>
              <h2
                id="bot-token-dialog-title"
                className="text-base font-bold text-zinc-900 dark:text-white"
              >
                Connect {integration.name} Bot
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Paste your bot token to link {integration.name}.
              </p>
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="bot-token"
                className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-zinc-700 dark:text-zinc-300"
              >
                <LockIcon size={12} className="h-3 w-3 text-zinc-400" />
                Bot Token
              </label>
              <input
                id="bot-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="123456789:AA..."
                disabled={isSubmitting}
                className={`w-full rounded-xl border bg-white px-3.5 py-2.5 text-sm text-zinc-900 placeholder-zinc-400 shadow-sm transition-all focus:outline-none focus:ring-2 dark:bg-zinc-800 dark:text-white ${
                  error
                    ? "border-red-300 focus:ring-red-200 dark:border-red-800"
                    : "border-zinc-200 focus:border-brand-500 focus:ring-brand-500/20 dark:border-zinc-700"
                }`}
              />
              <p className="mt-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
                Your token is stored securely and used only to authenticate this bot.
              </p>
              {error && (
                <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-600 dark:bg-red-950/40 dark:text-red-400">
                  <AlertTriangleIcon size={13} className="h-3 w-3 shrink-0" />
                  {error}
                </p>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={closeConnectDialog}
                disabled={isSubmitting}
                className="rounded-xl border border-zinc-200 bg-white px-4 py-2 text-xs font-semibold text-zinc-600 transition-all hover:bg-zinc-50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-xs font-bold text-white shadow-sm transition-all hover:bg-brand-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? (
                  <>
                    <Loader2Icon size={14} className="h-3.5 w-3.5 animate-spin" />
                    Connecting…
                  </>
                ) : (
                  <>
                    <CheckCircleIcon size={14} className="h-3.5 w-3.5" />
                    Connect
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default BotTokenConnectDialog;
