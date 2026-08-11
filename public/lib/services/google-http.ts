import { glogger } from "./google-logger";

const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

export function parseHeaders(headers: { name: string; value?: string }[] | undefined) {
  const map: Record<string, string> = {};
  (headers ?? []).forEach((h) => {
    if (h.name && h.value) map[h.name.toLowerCase()] = h.value;
  });
  return {
    subject: map["subject"] ?? null,
    from: map["from"] ?? null,
    to: map["to"] ?? null,
    date: map["date"] ?? null,
  };
}

export async function safeFetch(url: string, opts: RequestInit, meta: Record<string, any> = {}, timeoutMs = 8000, maxRetries = 1) {
  const logMeta = { ...meta };
  if (logMeta.headers) {
    const headers = { ...logMeta.headers } as any;
    if (typeof headers === "object") headers.Authorization = "[REDACTED]";
    logMeta.headers = headers;
  }
  glogger.debug("GoogleHTTP: calling Google API", logMeta);

  let attempt = 0;
  const backoff = (n: number) => Math.min(500 * 2 ** n, 5000);

  while (true) {
    attempt++;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(id);
      if (TRANSIENT_STATUS.has(res.status) && attempt <= maxRetries) {
        glogger.warn("GoogleHTTP: transient error, will retry", { url, status: res.status, attempt });
        await new Promise((r) => setTimeout(r, backoff(attempt)));
        continue;
      }
      return res;
    } catch (err: any) {
      clearTimeout(id);
      const isAbort = err?.name === "AbortError";
      if ((isAbort || err?.code === "ECONNRESET" || err?.code === "ENOTFOUND" || err?.code === "ETIMEDOUT") && attempt <= maxRetries) {
        glogger.warn("GoogleHTTP: network/transient error, retrying", { url, attempt, error: String(err) });
        await new Promise((r) => setTimeout(r, backoff(attempt)));
        continue;
      }
      glogger.error("GoogleHTTP: network error calling Google API", { error: String(err), url });
      throw err;
    }
  }
}

export function makeConcurrencyLimiter(limit = 5) {
  let active = 0;
  const queue: Array<() => void> = [];
  const runNext = () => {
    const next = queue.shift();
    if (!next) return;
    active++;
    next();
  };
  return async function <T>(fn: () => Promise<T>): Promise<T> {
    if (active < limit) {
      active++;
      try {
        const res = await fn();
        return res;
      } finally {
        active--;
        runNext();
      }
    }
    return await new Promise<T>((resolve, reject) => {
      queue.push(async () => {
        try {
          const r = await fn();
          resolve(r);
        } catch (e) {
          reject(e);
        } finally {
          active--;
          runNext();
        }
      });
    });
  };
}
