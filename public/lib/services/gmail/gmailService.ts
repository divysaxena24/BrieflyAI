import { getCurrentUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { glogger } from "@/lib/services/google-logger";
import { getUserIntegrationByPlatform, findUserByAuthId, logActivity } from "@/lib/db/queries";
import tokenManager from "@/lib/services/integrations/googleTokenManager";
import { GmailClient, buildMessageSummaryFromGmail, buildMessageDetailFromGmail, createMetadataFetchLimiter } from "./gmailClient";
import { googleCache } from "@/lib/services/google-cache";
import { mapStatusToAppError } from "@/lib/services/google-errors";
import type { ListMessagesResult, MessageSummary, MessageDetail, ThreadDetail } from "./types";

const PLATFORM = "gmail"; // matches the platform stored by OAuth callback
const LABEL_CACHE_MS = 1000 * 60 * 5; // 5 minutes

const limiter = createMetadataFetchLimiter(5);
const LABEL_CACHE_KEY = "labels";

export class GmailService {
  // returns both client and integration record to support caching and error handling
  static async createClientForUser() {
    const user = await getCurrentUser();
    if (!user) throw new AppError("Not authenticated", 401, "authentication_required");

    // Resolve the application user ID — getCurrentUser() returns auth.users.id,
    // but integrations.user_id references users.id (the application-level ID)
    const appUser = await findUserByAuthId(user.id);
    if (!appUser) throw new AppError("User not found", 404, "user_not_found");

    const integration = await getUserIntegrationByPlatform(appUser.id, PLATFORM);
    if (!integration) throw new AppError("No Google integration found for user", 404, "google_not_connected");

    // Obtain valid access token via centralized token manager
    glogger.debug("GmailService: requesting access token", { integrationId: integration.id });
    const token = await tokenManager.getValidAccessToken(integration.id);
    if (!token || !token.accessToken) throw new AppError("Authentication required", 401, "authentication_required");

    glogger.info("GmailService: access token obtained", { integrationId: integration.id });
    return { client: new GmailClient(token.accessToken), integration };
  }

  static async listMessages(params: { maxResults?: number; pageToken?: string; labelIds?: string[] } = {}): Promise<ListMessagesResult> {
    glogger.info("GmailService: listMessages request received", { params });
    const { client, integration } = await GmailService.createClientForUser();
    try {
      const idsResp = await client.listMessageIds({ maxResults: params.maxResults ?? 20, pageToken: params.pageToken, labelIds: params.labelIds });
      const messagesMeta = idsResp.messages ?? [];
      const nextPageToken = idsResp.nextPageToken ?? null;

      // throttle metadata fetches to avoid hitting quota and N+1 issues
      const detailPromises = messagesMeta.map((m: any) => limiter(() => client.getMessageMetadata(m.id)));
      const details = await Promise.all(detailPromises);
      const messages = details.map((d: any) => buildMessageSummaryFromGmail(d));

      glogger.info("GmailService: messages returned", { count: messages.length });
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Listed Gmail messages",
        details: `Listed ${messages.length} messages`,
        integrationId: integration.id,
      }).catch((e) => glogger.debug("logActivity failed", { error: String(e) }));
      return { messages, nextPageToken };
    } catch (err: any) {
      glogger.error("GmailService: listMessages failed", { error: String(err) });
      if (err instanceof AppError) throw err;
      const status = err?.status ?? err?.statusCode ?? null;
      // Try to extract the real Google API error from the response body before it is lost
      let body: any = undefined;
      try { if (typeof err?.json === "function") body = await err.json(); } catch {}
      if (status === 401 ) {
        try { await tokenManager.invalidate(integration.id); } catch (e) { glogger.debug("GmailService: failed to invalidate token", { integrationId: integration.id, error: String(e) }); }
      }
      throw mapStatusToAppError(status, body);
    }
  }

  static async getMessage(id: string): Promise<MessageDetail> {
    glogger.info("GmailService: getMessage request received", { messageId: id });
    const { client, integration } = await GmailService.createClientForUser();
    try {
      const resp = await client.getMessage(id);
      const detail = buildMessageDetailFromGmail(resp);
      glogger.info("GmailService: message returned", { messageId: id });
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Viewed Email",
        details: `Viewed email ${id}`,
        integrationId: integration.id,
      }).catch((e) => glogger.debug("logActivity failed", { error: String(e) }));
      return detail;
    } catch (err: any) {
      glogger.error("GmailService: getMessage failed", { messageId: id, error: String(err) });
      if (err instanceof AppError) throw err;
      const status = err?.status ?? err?.statusCode ?? null;
      // Try to extract the real Google API error from the response body before it is lost
      let body: any = undefined;
      try { if (typeof err?.json === "function") body = await err.json(); } catch {}
      if (status === 401 ) { try { await tokenManager.invalidate(integration.id); } catch {} }
      throw mapStatusToAppError(status, body);
    }
  }

  static async getThread(id: string): Promise<ThreadDetail> {
    glogger.info("GmailService: getThread request received", { threadId: id });
    const { client, integration } = await GmailService.createClientForUser();
    try {
      const resp = await client.getThread(id);
      const msgs = (resp.messages ?? []).map((m: any) => buildMessageDetailFromGmail(m));
      glogger.info("GmailService: thread returned", { threadId: id, count: msgs.length });
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Viewed Thread",
        details: `Viewed thread ${id} with ${msgs.length} messages`,
        integrationId: integration.id,
      }).catch((e) => glogger.debug("logActivity failed", { error: String(e) }));
      return { id: resp.id, messages: msgs };
    } catch (err: any) {
      glogger.error("GmailService: getThread failed", { threadId: id, error: String(err) });
      if (err instanceof AppError) throw err;
      const status = err?.status ?? err?.statusCode ?? null;
      // Try to extract the real Google API error from the response body before it is lost
      let body: any = undefined;
      try { if (typeof err?.json === "function") body = await err.json(); } catch {}
      if (status === 401 ) { try { await tokenManager.invalidate(integration.id); } catch {} }
      throw mapStatusToAppError(status, body);
    }
  }

  static async searchMessages(q: string, maxResults?: number, pageToken?: string) {
    glogger.info("GmailService: searchMessages request received", { q, maxResults, pageToken });
    const { client, integration } = await GmailService.createClientForUser();
    try {
      const idsResp = await client.listMessageIds({ q, maxResults, pageToken });
      const messagesMeta = idsResp.messages ?? [];
      const nextPageToken = idsResp.nextPageToken ?? null;
      const detailPromises = messagesMeta.map((m: any) => limiter(() => client.getMessageMetadata(m.id)));
      const details = await Promise.all(detailPromises);
      const messages = details.map((d: any) => buildMessageSummaryFromGmail(d));
      glogger.info("GmailService: search completed", { count: messages.length });
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Searched Gmail",
        details: q ? `Searched for "${q}"` : `Listed all messages`,
        integrationId: integration.id,
      }).catch((e) => glogger.debug("logActivity failed", { error: String(e) }));
      return { messages, nextPageToken };
    } catch (err: any) {
      glogger.error("GmailService: searchMessages failed", { error: String(err) });
      if (err instanceof AppError) throw err;
      const status = err?.status ?? err?.statusCode ?? null;
      // Try to extract the real Google API error from the response body before it is lost
      let body: any = undefined;
      try { if (typeof err?.json === "function") body = await err.json(); } catch {}
      if (status === 401 ) { try { await tokenManager.invalidate(integration.id); } catch {} }
      throw mapStatusToAppError(status, body);
    }
  }

  static async listLabels() {
    glogger.info("GmailService: listLabels request received");
    const { client, integration } = await GmailService.createClientForUser();
    try {
      const store = googleCache.getIntegrationStore(integration.id);
      const cached = store.get<any[]>(LABEL_CACHE_KEY);
      if (cached) {
        glogger.debug("GmailService: returning cached labels", { integrationId: integration.id, count: cached.length });
        return cached;
      }

      const resp = await client.listLabels();
      const labels = (resp.labels ?? []).map((l: any) => ({ id: l.id, name: l.name, messageListVisibility: l.messageListVisibility ?? null }));

      store.set(LABEL_CACHE_KEY, labels, LABEL_CACHE_MS);
      glogger.info("GmailService: labels fetched and cached", { integrationId: integration.id, count: labels.length });
      return labels;
    } catch (err: any) {
      glogger.error("GmailService: listLabels failed", { error: String(err) });
      if (err instanceof AppError) throw err;
      const status = err?.status ?? err?.statusCode ?? null;
      // Try to extract the real Google API error from the response body before it is lost
      let body: any = undefined;
      try { if (typeof err?.json === "function") body = await err.json(); } catch {}
      if (status === 401 ) { try { await tokenManager.invalidate(integration.id); } catch {} }
      throw mapStatusToAppError(status, body);
    }
  }
}

export default GmailService;