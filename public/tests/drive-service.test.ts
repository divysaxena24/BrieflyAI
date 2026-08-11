import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError } from '@/lib/errors';

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }));
vi.mock('@/lib/db/queries', () => ({ getUserIntegrationByPlatform: vi.fn(), findUserByAuthId: vi.fn(), logActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/services/integrations/googleTokenManager', () => ({
  default: { getValidAccessToken: vi.fn(), invalidate: vi.fn() },
}));
vi.mock('@/lib/services/google-cache', () => {
  const cache = new Map<string, { value: any; ts: number; ttl: number }>();
  return {
    googleCache: {
      getIntegrationStore: vi.fn(() => ({
        get: <T>(key: string): T | undefined => {
          const e = cache.get(key);
          if (!e) return undefined;
          if (Date.now() - e.ts > e.ttl) { cache.delete(key); return undefined; }
          return e.value as T;
        },
        set: <T>(key: string, value: T, ttl = 300000) => cache.set(key, { value, ts: Date.now(), ttl }),
        del: (key: string) => cache.delete(key),
        clear: () => cache.clear(),
      })),
    },
  };
});

import { getCurrentUser } from '@/lib/auth';
import { getUserIntegrationByPlatform, findUserByAuthId } from '@/lib/db/queries';
import tokenManager from '@/lib/services/integrations/googleTokenManager';
import DriveService from '@/lib/services/drive';

const mockUser = { id: 'user-1', email: 'test@example.com' };
const mockIntegration = { id: 'int-1', platform: 'google', userId: 'user-1' };
const mockToken = { accessToken: 'valid-token' };

// Tests that need the REAL createClientForUser (no spy)
describe('DriveService createClientForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getCurrentUser as any).mockResolvedValue(mockUser);
    (getUserIntegrationByPlatform as any).mockResolvedValue(mockIntegration);
    (findUserByAuthId as any).mockResolvedValue(mockUser);
    (tokenManager.getValidAccessToken as any).mockResolvedValue(mockToken);
  });

  it('throws AppError when not authenticated', async () => {
    (getCurrentUser as any).mockResolvedValue(null);
    await expect(DriveService.createClientForUser()).rejects.toMatchObject({ code: 'authentication_required' });
  });

  it('throws AppError when no integration', async () => {
    (getUserIntegrationByPlatform as any).mockResolvedValue(null);
    await expect(DriveService.createClientForUser()).rejects.toMatchObject({ code: 'google_not_connected' });
  });

  it('returns client and integration', async () => {
    const result = await DriveService.createClientForUser();
    expect(result.client).toBeDefined();
    expect(result.integration).toEqual(mockIntegration);
  });
});

// Tests that mock createClientForUser
describe('DriveService methods', () => {
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    (getCurrentUser as any).mockResolvedValue(mockUser);
    (getUserIntegrationByPlatform as any).mockResolvedValue(mockIntegration);
    (tokenManager.getValidAccessToken as any).mockResolvedValue(mockToken);

    mockClient = {
      listFiles: vi.fn(),
      getFile: vi.fn(),
      searchFiles: vi.fn(),
      listFolders: vi.fn(),
      getAbout: vi.fn(),
    };
    vi.spyOn(DriveService, 'createClientForUser').mockResolvedValue({ client: mockClient, integration: mockIntegration });
  });

  describe('toDriveFile', () => {
    it('maps raw file to DriveFile DTO', () => {
      const rawFile = {
        id: 'file-1', name: 'document.pdf', mimeType: 'application/pdf', size: '2048',
        createdTime: '2025-01-01T00:00:00Z', modifiedTime: '2025-01-10T00:00:00Z',
        owners: [{ displayName: 'Owner', emailAddress: 'owner@test.com' }],
        parents: ['parent-1'], webViewLink: 'https://drive.google.com/file/d/file-1',
        iconLink: 'https://drive.google.com/icon', thumbnailLink: 'https://thumbnail',
      };
      const file = DriveService.toDriveFile(rawFile);
      expect(file.id).toBe('file-1');
      expect(file.name).toBe('document.pdf');
      expect(file.size).toBe(2048);
      expect(file.isFolder).toBe(false);
      expect(file.owners![0].displayName).toBe('Owner');
    });

    it('detects folders by mimeType', () => {
      const f = DriveService.toDriveFile({ id: 'f1', name: 'My Folder', mimeType: 'application/vnd.google-apps.folder' });
      expect(f.isFolder).toBe(true);
      expect(f.size).toBeNull();
    });
  });

  describe('listFiles', () => {
    it('returns list of files with pagination', async () => {
      mockClient.listFiles.mockResolvedValue({
        files: [{ id: 'file-1', name: 'doc.pdf', mimeType: 'application/pdf', size: '2048' }],
        nextPageToken: 'next-drive-page',
      });
      const result = await DriveService.listFiles({ pageSize: 10 });
      expect(result.files).toHaveLength(1);
      expect(result.nextPageToken).toBe('next-drive-page');
      expect(result.files[0].name).toBe('doc.pdf');
    });

    it('builds folder query when folderId provided', async () => {
      mockClient.listFiles.mockResolvedValue({ files: [], nextPageToken: null });
      await DriveService.listFiles({ folderId: 'parent-1' });
      expect(mockClient.listFiles).toHaveBeenCalledWith(expect.objectContaining({
        q: "'parent-1' in parents and trashed = false",
      }));
    });

    it('throws AppError on 401 and invalidates token', async () => {
      mockClient.listFiles.mockRejectedValue({ status: 401 });
      await expect(DriveService.listFiles()).rejects.toMatchObject({ code: 'authentication_required' });
      expect(tokenManager.invalidate).toHaveBeenCalledWith('int-1');
    });
  });

  describe('getFile', () => {
    it('returns a single file', async () => {
      mockClient.getFile.mockResolvedValue({
        id: 'file-x', name: 'doc.pdf', mimeType: 'application/pdf', size: '1024',
      });
      const result = await DriveService.getFile('file-x');
      expect(result.id).toBe('file-x');
      expect(result.name).toBe('doc.pdf');
    });

    it('throws AppError on 404', async () => {
      mockClient.getFile.mockRejectedValue({ status: 404 });
      await expect(DriveService.getFile('unique-notfound-id')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    });

    it('throws AppError on 403', async () => {
      mockClient.getFile.mockRejectedValue({ status: 403 });
      await expect(DriveService.getFile('unique-noperms-id')).rejects.toMatchObject({ code: 'permission_denied' });
    });
  });

  describe('searchFiles', () => {
    it('searches files by query', async () => {
      mockClient.searchFiles.mockResolvedValue({
        files: [{ id: 'f1', name: 'found.txt', mimeType: 'text/plain' }],
        nextPageToken: null,
      });
      const result = await DriveService.searchFiles('name contains "found"', 10, 'p-1');
      expect(result.files).toHaveLength(1);
    });
  });

  describe('listFolders', () => {
    it('returns folders', async () => {
      mockClient.listFolders.mockResolvedValue({
        files: [{ id: 'folder-1', name: 'My Folder' }],
        nextPageToken: null,
      });
      const result = await DriveService.listFolders(50, 'p-1');
      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('My Folder');
    });
  });

  describe('getAbout', () => {
    it('returns about info', async () => {
      mockClient.getAbout.mockResolvedValue({
        user: { displayName: 'Me' }, storageQuota: { usage: 100 },
      });
      const result = await DriveService.getAbout();
      expect(result.user.displayName).toBe('Me');
    });

    it('throws mapped error on failure', async () => {
      mockClient.getAbout.mockRejectedValue({ status: 500 });
      await expect(DriveService.getAbout()).rejects.toMatchObject({ code: 'google_server_error', status: 502 });
    });
  });
});
