import { logger } from "@/lib/logger";

export function parseHeaders(headers: { name: string; value?: string }[]) {
  const map: Record<string, string> = {};
  headers.forEach((h) => {
    if (h.name && h.value) map[h.name.toLowerCase()] = h.value;
  });
  return {
    subject: map["subject"] ?? null,
    from: map["from"] ?? null,
    to: map["to"] ?? null,
    date: map["date"] ?? null,
  };
}

export async function safeFetch(url: string, opts: RequestInit, meta: Record<string, any> = {}) {
  // wrapper to log calls without leaking sensitive tokens
  const logMeta = { ...meta };
  if (logMeta.headers) {
    // redact Authorization
    const headers = { ...logMeta.headers } as any;
    if (typeof headers === "object") headers.Authorization = "[REDACTED]";
    logMeta.headers = headers;
  }
  logger.debug("GmailClient: calling Gmail API", logMeta);
  try {
    const res = await fetch(url, opts);
    return res;
  } catch (err) {
    logger.error("GmailClient: network error calling Gmail API", { error: String(err), url });
    throw err;
  }
}
