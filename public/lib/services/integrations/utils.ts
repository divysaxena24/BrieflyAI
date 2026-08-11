import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { ProviderId } from "./types";

export function normalizeProviderId(raw?: string) {
  if (!raw) throw new AppError("Provider id is required", 400, "invalid_provider");
  return String(raw).trim().toLowerCase();
}

export function getProviderDisplayName(id: ProviderId) {
  // Simple mapping for display purposes. Providers can override via their provider.displayName.
  const map: Record<string, string> = {
    gmail: "Gmail",
    "google-calendar": "Google Calendar",
    "google-drive": "Google Drive",
    github: "GitHub",
    discord: "Discord",
    telegram: "Telegram",
    whatsapp: "WhatsApp",
  };
  return map[id] ?? id;
}

export function validateProviderId(id?: string) {
  try {
    return normalizeProviderId(id);
  } catch (err) {
    logger.warn("validateProviderId failed", { error: err });
    throw err;
  }
}
