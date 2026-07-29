import { getCurrentUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getUserIntegrationByPlatform } from "@/lib/db/queries";
import tokenManager from "@/lib/services/integrations/googleTokenManager";
import { GmailClient, buildMessageSummaryFromGmail, buildMessageDetailFromGmail } from "./gmailClient";
import type { ListMessagesResult, MessageSummary, MessageDetail, ThreadDetail } from "./types";

const PLATFORM = "google"; // provider id used for Google account

export class GmailService {
  static async createClientForUser() {
    const user = await getCurrentUser();
    if (!user) throw new AppError("Not authenticated", 401, "authentication_required");

    const integration = await getUserIntegrationByPlatform(user.id, PLATFORM);
    if (!integration) throw new AppError("No Google integration found for user", 404, "google_not_connected");

    // Obtain valid access token via centralized token manager
    logger.debug("GmailService: requesting access token", { integrationId: integration.id });
    const token = await tokenManager.getValidAccessToken(integration.id);
    if (!token || !token.accessToken) throw new AppError("Authentication required", 401, "authentication_required");

    logger.info("GmailService: access token obtained", { integrationId: integration.id });
    return new GmailClient(token.accessToken);
  }

  static async listMessages(params: { maxResults?: number; pageToken?: string; labelIds?: string[] } = {}): Promise<ListMessagesResult> {
    logger.info("GmailService: listMessages request received", { params });
    const client = await GmailService.createClientForUser();
    try {
      const idsResp = await client.listMessageIds({ maxResults: params.maxResults ?? 20, pageToken: params.pageToken, labelIds: params.labelIds });
      const messagesMeta = idsResp.messages ?? [];
      const nextPageToken = idsResp.nextPageToken ?? null;

      // fetch metadata for each message (subject, from, to)
      const detailPromises = messagesMeta.map((m: any) => client.getMessageMetadata(m.id));
      const details = await Promise.all(detailPromises);
      const messages = details.map((d: any) => buildMessageSummaryFromGmail(d));

      logger.info("GmailService: messages returned", { count: messages.length });
      return { messages, nextPageToken };
    } catch (err: any) {
      logger.error("GmailService: listMessages failed", { error: String(err) });
      if (err instanceof AppError) throw err;
      if (err?.status === 404) throw new AppError("Message not found", 404, "not_found");
      throw new AppError("Failed to list messages", 502, "gmail_error");
    }
  }

  static async getMessage(id: string): Promise<MessageDetail> {
    logger.info("GmailService: getMessage request received", { messageId: id });
    const client = await GmailService.createClientForUser();
    try {
      const resp = await client.getMessage(id);
      const detail = buildMessageDetailFromGmail(resp);
      logger.info("GmailService: message returned", { messageId: id });
      return detail;
    } catch (err: any) {
      logger.error("GmailService: getMessage failed", { messageId: id, error: String(err) });
      if (err instanceof AppError) throw err;
      if (err?.status === 404) throw new AppError("Message not found", 404, "not_found");
      throw new AppError("Failed to fetch message", 502, "gmail_error");
    }
  }

  static async getThread(id: string): Promise<ThreadDetail> {
    logger.info("GmailService: getThread request received", { threadId: id });
    const client = await GmailService.createClientForUser();
    try {
      const resp = await client.getThread(id);
      const msgs = (resp.messages ?? []).map((m: any) => buildMessageDetailFromGmail(m));
      logger.info("GmailService: thread returned", { threadId: id, count: msgs.length });
      return { id: resp.id, messages: msgs };
    } catch (err: any) {
      logger.error("GmailService: getThread failed", { threadId: id, error: String(err) });
      if (err instanceof AppError) throw err;
      if (err?.status === 404) throw new AppError("Thread not found", 404, "not_found");
      throw new AppError("Failed to fetch thread", 502, "gmail_error");
    }
  }

  static async searchMessages(q: string, maxResults?: number, pageToken?: string) {
    logger.info("GmailService: searchMessages request received", { q, maxResults, pageToken });
    const client = await GmailService.createClientForUser();
    try {
      const idsResp = await client.listMessageIds({ q, maxResults, pageToken });
      const messagesMeta = idsResp.messages ?? [];
      const nextPageToken = idsResp.nextPageToken ?? null;
      const detailPromises = messagesMeta.map((m: any) => client.getMessageMetadata(m.id));
      const details = await Promise.all(detailPromises);
      const messages = details.map((d: any) => buildMessageSummaryFromGmail(d));
      logger.info("GmailService: search completed", { count: messages.length });
      return { messages, nextPageToken };
    } catch (err: any) {
      logger.error("GmailService: searchMessages failed", { error: String(err) });
      if (err instanceof AppError) throw err;
      throw new AppError("Failed to search messages", 502, "gmail_error");
    }
  }

  static async listLabels() {
    logger.info("GmailService: listLabels request received");
    const client = await GmailService.createClientForUser();
    try {
      const resp = await client.listLabels();
      // normalize label shapes
      const labels = (resp.labels ?? []).map((l: any) => ({ id: l.id, name: l.name, messageListVisibility: l.messageListVisibility ?? null }));
      return labels;
    } catch (err: any) {
      logger.error("GmailService: listLabels failed", { error: String(err) });
      if (err instanceof AppError) throw err;
      throw new AppError("Failed to list labels", 502, "gmail_error");
    }
  }
}

export default GmailService;
