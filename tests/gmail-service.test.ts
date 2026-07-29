import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError } from '@/lib/errors';

// Mock external dependencies - hoisted by vitest
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }));
vi.mock('@/lib/db/queries', () => ({ getUserIntegrationByPlatform: vi.fn(), findUserByAuthId: vi.fn(), logActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/services/integrations/googleTokenManager', () => ({
  default: { getValidAccessToken: vi.fn(), invalidate: vi.fn() },
}));

// Shared in-memory cache for all googleCache calls within a test suite
const mockCacheData = new Map<string, { value: any; ts: number; ttl: number }>();
vi.mock('@/lib/services/google-cache', () => ({
  googleCache: {
    getIntegrationStore: vi.fn(() => ({
      get: <T>(key: string): T | undefined => {
        const e = mockCacheData.get(key);
        if (!e) return undefined;
        if (Date.now() - e.ts > e.ttl) { mockCacheData.delete(key); return undefined; }
        return e.value as T;
      },
      set: <T>(key: string, value: T, ttl = 300000) => mockCacheData.set(key, { value, ts: Date.now(), ttl }),
      del: (key: string) => mockCacheData.delete(key),
      clear: () => mockCacheData.clear(),
    })),
  },
}));

import { getCurrentUser } from '@/lib/auth';
import { getUserIntegrationByPlatform, findUserByAuthId } from '@/lib/db/queries';
import tokenManager from '@/lib/services/integrations/googleTokenManager';
import { GmailClient } from '@/lib/services/gmail';
import GmailService from '@/lib/services/gmail';

describe('GmailService', () => {
  const mockUser = { id: 'user-1', email: 'test@example.com' };
  const mockIntegration = { id: 'int-1', platform: 'google', userId: 'user-1', accessToken: 'old-token', refreshToken: 'refresh-1', expiresAt: null };
  const mockToken = { accessToken: 'valid-token', refreshToken: 'refresh-1', expiresAt: null };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCacheData.clear();
    (getCurrentUser as any).mockResolvedValue(mockUser);
    (getUserIntegrationByPlatform as any).mockResolvedValue(mockIntegration);
    (findUserByAuthId as any).mockResolvedValue(mockUser);
    (tokenManager.getValidAccessToken as any).mockResolvedValue(mockToken);
    (tokenManager.invalidate as any).mockResolvedValue(undefined);
  });

  describe('createClientForUser', () => {
    it('throws AppError when user is not authenticated', async () => {
      (getCurrentUser as any).mockResolvedValue(null);
      await expect(GmailService.createClientForUser()).rejects.toThrow(AppError);
      await expect(GmailService.createClientForUser()).rejects.toMatchObject({ code: 'authentication_required', status: 401 });
    });

    it('throws AppError when no Google integration exists', async () => {
      (getUserIntegrationByPlatform as any).mockResolvedValue(null);
      await expect(GmailService.createClientForUser()).rejects.toMatchObject({ code: 'google_not_connected', status: 404 });
    });

    it('throws AppError when token manager returns no token', async () => {
      (tokenManager.getValidAccessToken as any).mockResolvedValue(null);
      await expect(GmailService.createClientForUser()).rejects.toMatchObject({ code: 'authentication_required', status: 401 });
    });

    it('returns client and integration on success', async () => {
      const result = await GmailService.createClientForUser();
      expect(result.client).toBeDefined();
      expect(result.integration).toEqual(mockIntegration);
      expect(tokenManager.getValidAccessToken).toHaveBeenCalledWith('int-1');
    });
  });

  describe('listMessages', () => {
    beforeEach(() => {
      vi.spyOn(GmailClient.prototype, 'listMessageIds').mockResolvedValue({
        messages: [
          { id: 'msg-1', threadId: 'thr-1' },
          { id: 'msg-2', threadId: 'thr-2' },
        ],
        nextPageToken: 'next-page',
      });
      vi.spyOn(GmailClient.prototype, 'getMessageMetadata')
        .mockResolvedValueOnce({
          id: 'msg-1', threadId: 'thr-1', labelIds: ['INBOX'], snippet: 'Hello',
          payload: { headers: [{ name: 'Subject', value: 'Test Subject' }, { name: 'From', value: 'sender@test.com' }] },
        })
        .mockResolvedValueOnce({
          id: 'msg-2', threadId: 'thr-2', labelIds: ['INBOX', 'UNREAD'], snippet: 'World',
          payload: { headers: [{ name: 'Subject', value: 'Re: Test Subject' }, { name: 'From', value: 'someone@test.com' }] },
        });
    });

    it('returns messages and nextPageToken', async () => {
      const result = await GmailService.listMessages({ maxResults: 2 });
      expect(result.messages).toHaveLength(2);
      expect(result.nextPageToken).toBe('next-page');
      expect(result.messages[0].subject).toBe('Test Subject');
      expect(result.messages[0].from).toBe('sender@test.com');
      expect(result.messages[1].isUnread).toBe(true);
    });

    it('handles empty result', async () => {
      vi.spyOn(GmailClient.prototype, 'listMessageIds').mockResolvedValue({ messages: [], nextPageToken: null });
      const result = await GmailService.listMessages({ maxResults: 20 });
      expect(result.messages).toHaveLength(0);
      expect(result.nextPageToken).toBeNull();
    });

    it('returns empty messages when response has no messages field', async () => {
      vi.spyOn(GmailClient.prototype, 'listMessageIds').mockResolvedValue({});
      const result = await GmailService.listMessages();
      expect(result.messages).toHaveLength(0);
    });

    it('passes pagination params correctly', async () => {
      const spy = vi.spyOn(GmailClient.prototype, 'listMessageIds').mockResolvedValue({ messages: [], nextPageToken: null });
      await GmailService.listMessages({ maxResults: 50, pageToken: 'page-1', labelIds: ['INBOX'] });
      expect(spy).toHaveBeenCalledWith({ maxResults: 50, pageToken: 'page-1', labelIds: ['INBOX'] });
    });
  });

  describe('listMessages error handling', () => {
    it('throws AppError on 401 and invalidates token', async () => {
      vi.spyOn(GmailClient.prototype, 'listMessageIds').mockRejectedValue({ status: 401 });
      await expect(GmailService.listMessages()).rejects.toMatchObject({ code: 'authentication_required' });
      expect(tokenManager.invalidate).toHaveBeenCalledWith('int-1');
    });

    it('throws AppError on 403 without invalidating token', async () => {
      vi.spyOn(GmailClient.prototype, 'listMessageIds').mockRejectedValue({ status: 403 });
      await expect(GmailService.listMessages()).rejects.toMatchObject({ code: 'permission_denied' });
      expect(tokenManager.invalidate).not.toHaveBeenCalled();
    });

    it('throws AppError on 404', async () => {
      vi.spyOn(GmailClient.prototype, 'listMessageIds').mockRejectedValue({ status: 404 });
      await expect(GmailService.listMessages()).rejects.toMatchObject({ code: 'not_found' });
    });

    it('throws AppError on 429', async () => {
      vi.spyOn(GmailClient.prototype, 'listMessageIds').mockRejectedValue({ status: 429 });
      await expect(GmailService.listMessages()).rejects.toMatchObject({ code: 'rate_limited' });
    });

    it('throws generic AppError on 500', async () => {
      vi.spyOn(GmailClient.prototype, 'listMessageIds').mockRejectedValue({ status: 500 });
      await expect(GmailService.listMessages()).rejects.toMatchObject({ code: 'google_server_error' });
    });

    it('re-throws AppError instances directly', async () => {
      vi.spyOn(GmailClient.prototype, 'listMessageIds').mockRejectedValue(new AppError('Custom', 400, 'custom'));
      await expect(GmailService.listMessages()).rejects.toMatchObject({ code: 'custom', status: 400 });
    });
  });

  describe('getMessage', () => {
    it('returns message detail with attachments', async () => {
      vi.spyOn(GmailClient.prototype, 'getMessage').mockResolvedValue({
        id: 'msg-1', threadId: 'thr-1', labelIds: ['INBOX'], snippet: 'Hello world',
        payload: {
          headers: [{ name: 'Subject', value: 'Test' }, { name: 'From', value: 'a@b.com' }],
          parts: [{ filename: 'doc.pdf', mimeType: 'application/pdf', partId: '0', body: { size: 1024 } }],
        },
      });
      const result = await GmailService.getMessage('msg-1');
      expect(result.id).toBe('msg-1');
      expect(result.subject).toBe('Test');
      expect(result.from).toBe('a@b.com');
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments![0].filename).toBe('doc.pdf');
      expect(result.preview).toBe('Hello world');
    });

    it('handles missing payload gracefully', async () => {
      vi.spyOn(GmailClient.prototype, 'getMessage').mockResolvedValue({ id: 'msg-1', threadId: 'thr-1', labelIds: [], snippet: null });
      const result = await GmailService.getMessage('msg-1');
      expect(result.attachments).toHaveLength(0);
      expect(result.preview).toBeNull();
    });
  });

  describe('getThread', () => {
    it('returns thread with all messages', async () => {
      vi.spyOn(GmailClient.prototype, 'getThread').mockResolvedValue({
        id: 'thr-1',
        messages: [
          { id: 'msg-1', threadId: 'thr-1', labelIds: ['INBOX'], snippet: 'First',
            payload: { headers: [{ name: 'Subject', value: 'Thread Subject' }, { name: 'From', value: 'a@b.com' }] } },
          { id: 'msg-2', threadId: 'thr-1', labelIds: ['INBOX'], snippet: 'Second',
            payload: { headers: [{ name: 'Subject', value: 'Re: Thread Subject' }, { name: 'From', value: 'b@c.com' }] } },
        ],
      });
      const result = await GmailService.getThread('thr-1');
      expect(result.id).toBe('thr-1');
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].from).toBe('a@b.com');
      expect(result.messages[1].from).toBe('b@c.com');
    });

    it('handles empty messages array', async () => {
      vi.spyOn(GmailClient.prototype, 'getThread').mockResolvedValue({ id: 'thr-1', messages: [] });
      const result = await GmailService.getThread('thr-1');
      expect(result.messages).toHaveLength(0);
    });
  });

  describe('searchMessages', () => {
    it('searches with query and returns results', async () => {
      vi.spyOn(GmailClient.prototype, 'listMessageIds').mockResolvedValue({
        messages: [{ id: 'msg-1', threadId: 'thr-1' }],
        nextPageToken: null,
      });
      vi.spyOn(GmailClient.prototype, 'getMessageMetadata').mockResolvedValue({
        id: 'msg-1', threadId: 'thr-1', labelIds: ['INBOX'], snippet: 'Result',
        payload: { headers: [{ name: 'Subject', value: 'Search Hit' }, { name: 'From', value: 'a@b.com' }] },
      });
      const result = await GmailService.searchMessages('test query', 10, 'page-1');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].subject).toBe('Search Hit');
    });

    it('propagates AppError from underlying calls', async () => {
      vi.spyOn(GmailClient.prototype, 'listMessageIds').mockRejectedValue({ status: 500 });
      await expect(GmailService.searchMessages('test')).rejects.toThrow(AppError);
    });
  });

  describe('listLabels', () => {
    it('returns labels from API', async () => {
      vi.spyOn(GmailClient.prototype, 'listLabels').mockResolvedValue({
        labels: [
          { id: 'label-1', name: 'INBOX', messageListVisibility: 'show' },
          { id: 'label-2', name: 'SENT', messageListVisibility: 'hide' },
        ],
      });
      const result = await GmailService.listLabels();
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('INBOX');
    });

    it('caches labels and returns cached on subsequent call', async () => {
      const spy = vi.spyOn(GmailClient.prototype, 'listLabels').mockResolvedValue({
        labels: [{ id: 'label-1', name: 'INBOX', messageListVisibility: 'show' }],
      });

      const result1 = await GmailService.listLabels();
      const result2 = await GmailService.listLabels();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(result1).toEqual(result2);
    });
  });
});
