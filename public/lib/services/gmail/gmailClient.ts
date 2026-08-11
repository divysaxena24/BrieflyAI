import { safeFetch, parseHeaders, makeConcurrencyLimiter } from "@/lib/services/google-http";
import type { MessageSummary, MessageDetail } from "./types";

const BASE = "https://www.googleapis.com/gmail/v1/users/me";

export class GmailClient {
  accessToken: string;
  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private headers() {
    return { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" } as Record<string, string>;
  }

  // list message ids with minimal fields; listing does not reliably include headers, so metadata fetching still used for subjects
  async listMessageIds(params: { maxResults?: number; pageToken?: string; labelIds?: string[]; q?: string }) {
    const url = new URL(`${BASE}/messages`);
    if (params.maxResults) url.searchParams.set("maxResults", String(params.maxResults));
    if (params.pageToken) url.searchParams.set("pageToken", params.pageToken);
    if (params.q) url.searchParams.set("q", params.q);
    if (params.labelIds) params.labelIds.forEach((l) => url.searchParams.append("labelIds", l));
    // only ask for ids + threadId + nextPageToken to keep response small
    url.searchParams.set("fields", "messages/id,messages/threadId,nextPageToken");

    const res = await safeFetch(url.toString(), { method: "GET", headers: this.headers() }, { url: url.pathname });
    if (!res.ok) throw res;
    return res.json();
  }

  async getMessageMetadata(id: string) {
    const url = new URL(`${BASE}/messages/${encodeURIComponent(id)}`);
    // request metadata headers and snippet
    url.searchParams.set("format", "metadata");
    url.searchParams.append("metadataHeaders", "Subject");
    url.searchParams.append("metadataHeaders", "From");
    url.searchParams.append("metadataHeaders", "To");
    url.searchParams.append("metadataHeaders", "Date");
    url.searchParams.set("fields", "id,threadId,labelIds,snippet,payload(headers)");

    const res = await safeFetch(url.toString(), { method: "GET", headers: this.headers() }, { url: url.pathname, messageId: id });
    if (!res.ok) throw res;
    return res.json();
  }

  async getMessage(id: string) {
    // full metadata (but avoid downloading large body parts) -- include payload parts to inspect attachments metadata
    const url = new URL(`${BASE}/messages/${encodeURIComponent(id)}`);
    url.searchParams.set("format", "full");
    url.searchParams.set("fields", "id,threadId,labelIds,snippet,payload(headers,parts/filename,parts/mimeType,parts/partId,parts/headers)");
    const res = await safeFetch(url.toString(), { method: "GET", headers: this.headers() }, { url: url.pathname, messageId: id });
    if (!res.ok) throw res;
    return res.json();
  }

  async getThread(id: string) {
    const url = new URL(`${BASE}/threads/${encodeURIComponent(id)}`);
    url.searchParams.set("fields", "id,messages(id,threadId,labelIds,snippet,payload(headers,parts/filename,parts/mimeType,parts/partId,parts/headers))");
    const res = await safeFetch(url.toString(), { method: "GET", headers: this.headers() }, { url: url.pathname, threadId: id });
    if (!res.ok) throw res;
    return res.json();
  }

  async listLabels() {
    const url = `${BASE}/labels`;
    const res = await safeFetch(url, { method: "GET", headers: this.headers() }, { url: "/labels" });
    if (!res.ok) throw res;
    return res.json();
  }
}

export function buildMessageSummaryFromGmail(resp: any): MessageSummary {
  const headers = resp.payload?.headers ?? [];
  const parsed = parseHeaders(headers);
  const subject = parsed.subject;
  const from = parsed.from;
  const to = parsed.to;
  const date = parsed.date ? new Date(parsed.date).toISOString() : null;
  const snippet = resp.snippet ?? null;
  const labelIds = resp.labelIds ?? [];
  const isUnread = labelIds.includes("UNREAD");

  return {
    id: resp.id,
    threadId: resp.threadId,
    subject,
    from,
    to,
    date,
    snippet,
    labelIds,
    isUnread,
  };
}

export function buildMessageDetailFromGmail(resp: any): MessageDetail {
  const summary = buildMessageSummaryFromGmail(resp);
  // collect attachments metadata from payload.parts
  const parts = resp.payload?.parts ?? [];
  const attachments = [] as any[];
  const inlineImages = [] as any[];
  const walk = (p: any) => {
    if (!p) return;
    if (Array.isArray(p)) p.forEach(walk);
    else {
      if (p.filename) {
        attachments.push({ filename: p.filename, mimeType: p.mimeType, partId: p.partId, size: p.body?.size ?? null });
      }
      // inline images often have Content-Disposition: inline or small images with no filename
      if (p.body && !p.filename && /image\//.test(p.mimeType ?? "")) {
        inlineImages.push({ mimeType: p.mimeType, partId: p.partId, size: p.body?.size ?? null });
      }
      if (p.parts) walk(p.parts);
    }
  };
  walk(parts);

  const preview = resp.snippet ?? null;
  return { ...summary, preview, attachments, inlineImages };
}

export const createMetadataFetchLimiter = makeConcurrencyLimiter;