"use client";

import React, { useEffect, useState } from "react";
import { useIntegrationStatus, OAUTH_CONFIRM_ROUTES } from "@/lib/integrations/store";
import { PlatformIcon } from "./PlatformIcon";
import {
  Loader2Icon,
  LockIcon,
  CheckCircleIcon,
  ExternalLinkIcon,
} from "@/components/dashboard/icons";

/**
 * Shared connect dialog for OAuth platforms that show a confirmation screen
 * before redirecting the user to the provider's OAuth consent page.
 *
 * Any platform registered in the store's OAUTH_CONFIRM_ROUTES mapping opens this
 * dialog when Connect is clicked. The user reads the explanation and permissions,
 * then clicks "Continue with <Platform>" to trigger the actual browser redirect.
 * The dialog holds no backend logic — it delegates to the store's connectPlatform()
 * which performs the redirect.
 */
export const OAuthConnectDialog: React.FC = () => {
  const { connectDialogPlatform, getIntegration } = useIntegrationStatus();
  if (!connectDialogPlatform) return null;
  // Only render for platforms that use the OAuth confirmation flow.
  // The store's connectPlatform() opens this dialog for platforms registered
  // in OAUTH_CONFIRM_ROUTES (e.g. Discord). Bot-token platforms are handled
  // by their own dialog.
  const integration = getIntegration(connectDialogPlatform);
  if (!integration || integration.authenticationType !== "oauth") return null;
  return <OAuthConnectDialogInner key={connectDialogPlatform} platformId={connectDialogPlatform} />;
};

interface OAuthConnectDialogInnerProps {
  platformId: string;
}

const OAuthConnectDialogInner: React.FC<OAuthConnectDialogInnerProps> = ({ platformId }) => {
  const { getIntegration, closeConnectDialog } = useIntegrationStatus();
  const integration = getIntegration(platformId);
  const [isRedirecting, setIsRedirecting] = useState(false);

  // Close on Escape — blocked while redirecting
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isRedirecting) closeConnectDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeConnectDialog, isRedirecting]);

  if (!integration) return null;

  const handleContinue = () => {
    setIsRedirecting(true);
    // Build the OAuth redirect URL using the same pattern as the store's
    // buildConnectUrl(). The route is from OAUTH_CONFIRM_ROUTES (same as
    // OAUTH_ROUTES for Discord).
    const route = OAUTH_CONFIRM_ROUTES[platformId]?.connect ?? "discord-connect";
    const next = encodeURIComponent(window.location.pathname);
    window.location.href = `/api/integrations/${route}?platform=${platformId}&next=${next}`;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="oauth-dialog-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-zinc-950/60 backdrop-blur-sm"
        onClick={isRedirecting ? undefined : closeConnectDialog}
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
                id="oauth-dialog-title"
                className="text-base font-bold text-zinc-900 dark:text-white"
              >
                Connect {integration.name} Account
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Securely authorize {integration.name} to work with BrieflyAI.
              </p>
            </div>
            {!isRedirecting && (
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

          {/* Description */}
          <p className="mb-4 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
            BrieflyAI securely connects to your {integration.name} account using the official{" "}
            {integration.name} OAuth flow.
          </p>
          <p className="mb-5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
            After authorization, BrieflyAI can read the servers and channels you grant access to.
            Your {integration.name} password is never shared with BrieflyAI.
          </p>

          {/* How it works */}
          <div className="mb-4 rounded-xl border border-zinc-100 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-800/50">
            <h3 className="mb-2.5 text-xs font-bold text-zinc-800 dark:text-zinc-200">How it works</h3>
            <ol className="space-y-1.5">
              {[
                `Click "Continue with ${integration.name}".`,
                `${integration.name}'s official authorization page will open.`,
                `Log into ${integration.name} if required.`,
                "Review the requested permissions.",
                `Click "Authorize".`,
                "You will automatically return to BrieflyAI.",
              ].map((step, i) => (
                <li key={i} className="flex items-start gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-[9px] font-bold text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
                    {i + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </div>

          {/* Permissions info box */}
          <div className="mb-3 rounded-xl border border-indigo-100 bg-indigo-50/60 p-3.5 dark:border-indigo-900/60 dark:bg-indigo-950/30">
            <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold text-indigo-700 dark:text-indigo-300">
              <LockIcon size={12} className="h-3 w-3" />
              What permissions are requested?
            </h3>
            <ul className="space-y-1">
              {[
                "Identify your Discord account",
                "Read your Discord servers",
                "Read accessible text channels",
                "Read messages from authorized channels",
              ].map((perm, i) => (
                <li key={i} className="flex items-center gap-1.5 text-[11px] text-indigo-600 dark:text-indigo-400">
                  <span className="text-indigo-400 dark:text-indigo-500">•</span>
                  {perm}
                </li>
              ))}
            </ul>
          </div>

          {/* Security info box */}
          <div className="mb-3 rounded-xl border border-emerald-100 bg-emerald-50/60 p-3.5 dark:border-emerald-900/60 dark:bg-emerald-950/30">
            <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold text-emerald-700 dark:text-emerald-300">
              <CheckCircleIcon size={12} className="h-3 w-3" />
              Security
            </h3>
            <ul className="space-y-1">
              {[
                "Uses official Discord OAuth",
                "Your Discord password is never stored",
                "You can disconnect anytime",
              ].map((item, i) => (
                <li key={i} className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                  <CheckCircleIcon size={10} className="h-2.5 w-2.5 shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
            <button
              type="button"
              onClick={closeConnectDialog}
              disabled={isRedirecting}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-2 text-xs font-semibold text-zinc-600 transition-all hover:bg-zinc-50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleContinue}
              disabled={isRedirecting}
              className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold text-white shadow-sm transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
              style={{ backgroundColor: integration.accentColor }}
            >
              {isRedirecting ? (
                <>
                  <Loader2Icon size={14} className="h-3.5 w-3.5 animate-spin" />
                  Redirecting…
                </>
              ) : (
                <>
                  <ExternalLinkIcon size={14} className="h-3.5 w-3.5" />
                  Continue with {integration.name}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OAuthConnectDialog;