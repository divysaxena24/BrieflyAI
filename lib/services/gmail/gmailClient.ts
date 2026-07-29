import { safeFetch, parseHeaders } from "./utils";
import type { MessageSummary, MessageDetail } from "./types";

const BASE = "https://www.googleapis.com/gmail/v1/users/me";

export class GmailClient {
  accessToken: string;
  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private headers() {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  async listMessageIds(params: { maxResults?: number; pageToken?: string; labelIds?: string[]; q?: string }) {
    const url = new URL(`${BASE}/messages`);
    if (params.maxResults) url.searchParams.set("maxResults", String(params.maxResults));
    if (params.pageToken) url.searchParams.set("pageToken", params.pageToken);
    if (params.q) url.searchParams.set("q", params.q);
    if (params.labelIds) params.labelIds.forEach((l) => url.searchParams.append("labelIds", l));
    url.searchParams.set("fields", "messages/id,messages/threadId,nextPageToken");

    const res = await safeFetch(url.toString(), { method: "GET", headers: this.headers() }, { url: url.pathname });
    if (!res.ok) throw res;
    return res.json();
  }

  async getMessageMetadata(id: string) {
    const url = new URL(`${BASE}/messages/${encodeURIComponent(id)}`);
    // request only metadata headers and snippet
    url.searchParams.set("format", "metadata");
    url.searchParams.set("metadataHeaders", "Subject");
    url.searchParams.append("metadataHeaders", "From");
    url.searchParams.append("metadataHeaders", "To");
    url.searchParams.append("metadataHeaders", "Date");
    url.searchParams.set("fields", "id,threadId,labelIds,snippet,payload(headers)" );

    const res = await safeFetch(url.toString(), { method: "GET", headers: this.headers() }, { url: url.pathname, messageId: id });
    if (!res.ok) throw res;
    return res.json();
  }

  async getMessage(id: string) {
    // full metadata plus small preview (avoid full body)
    const url = new URL(`${BASE}/messages/${encodeURIComponent(id)}`);
    url.searchParams.set("format", "full");
    url.searchParams.set("fields", "id,threadId,labelIds,snippet,payload(headers,body/sizeEstimate,body/attachmentId)");
    const res = await safeFetch(url.toString(), { method: "GET", headers: this.headers() }, { url: url.pathname, messageId: id });
    if (!res.ok) throw res;
    return res.json();
  }

  async getThread(id: string) {
    const url = new URL(`${BASE}/threads/${encodeURIComponent(id)}`);
    url.searchParams.set("fields", "id,messages(id,threadId,labelIds,snippet,payload(headers))");
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
  // reuse summary builder and add preview
  const summary = buildMessageSummaryFromGmail(resp);
  const preview = resp.payload?.body?.size ? (resp.snippet ?? null) : (resp.snippet ?? null);
  return { ...summary, preview };
}
