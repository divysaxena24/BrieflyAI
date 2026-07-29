import { getCurrentUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { glogger } from "@/lib/services/google-logger";
import { getUserIntegrationByPlatform, findUserByAuthId, logActivity } from "@/lib/db/queries";
import tokenManager from "@/lib/services/integrations/googleTokenManager";
import { DriveClient } from "./driveClient";
import { mapStatusToAppError } from "@/lib/services/google-errors";
import { googleCache } from "@/lib/services/google-cache";
import type { DriveFile, DriveFolder, ListFilesResult } from "./types";

const PLATFORM = "gmail"; // matches the platform stored by OAuth callback
const CACHE_MS = 1000 * 60 * 5; // 5 minutes

export class DriveService {
  static async createClientForUser() {
    const user = await getCurrentUser();
    if (!user) throw new AppError("Not authenticated", 401, "authentication_required");

    // Resolve the application user ID — getCurrentUser() returns auth.users.id,
    // but integrations.user_id references users.id (the application-level ID)
    const appUser = await findUserByAuthId(user.id);
    if (!appUser) throw new AppError("User not found", 404, "user_not_found");

    const integration = await getUserIntegrationByPlatform(appUser.id, PLATFORM);
    if (!integration) throw new AppError("No Google integration found for user", 404, "google_not_connected");

    const token = await tokenManager.getValidAccessToken(integration.id);
    if (!token || !token.accessToken) throw new AppError("Authentication required", 401, "authentication_required");

    return { client: new DriveClient(token.accessToken), integration };
  }

  static async listFiles(params: { pageSize?: number; pageToken?: string; folderId?: string } = {}): Promise<ListFilesResult> {
    glogger.info("DriveService: listFiles request received", { params });
    const { client, integration } = await DriveService.createClientForUser();
    try {
      let q: string | undefined = undefined;
      if (params.folderId) q = `'${params.folderId}' in parents and trashed = false`;
      const res = await client.listFiles({ q, pageSize: params.pageSize, pageToken: params.pageToken, orderBy: "folder,modifiedTime desc" });
      const files = (res.files ?? []).map((f: any) => DriveService.toDriveFile(f));

      // cache files metadata in centralized google cache
      const store = googleCache.getIntegrationStore(integration.id);
      let filesMap = store.get<Map<string, { file: DriveFile; ts: number }>>("files");
      if (!filesMap) {
        filesMap = new Map<string, { file: DriveFile; ts: number }>();
        store.set("files", filesMap, CACHE_MS);
      }
      files.forEach((f: DriveFile) => filesMap!.set(f.id, { file: f, ts: Date.now() }));

      const nextPageToken = res.nextPageToken ?? null;
      glogger.info("DriveService: listFiles returned", { count: files.length });
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Listed Files",
        details: `Listed ${files.length} files`,
        integrationId: integration.id,
      }).catch((e) => glogger.debug("logActivity failed", { error: String(e) }));
      return { files, nextPageToken };
    } catch (err: any) {
      glogger.error("DriveService: listFiles failed", { error: String(err) });
      if (err instanceof AppError) throw err;
      const status = err?.status ?? err?.statusCode ?? null;
      // Try to extract the real Google API error from the response body before it is lost
      let body: any = undefined;
      try { if (typeof err?.json === "function") body = await err.json(); } catch {}
      if (status === 404) throw new AppError("Folder not found", 404, "not_found");
      if (status === 401 ) { try { await tokenManager.invalidate(integration.id); } catch {} }
      throw mapStatusToAppError(status, body);
    }
  }

  static toDriveFile(raw: any): DriveFile {
    return {
      id: raw.id,
      name: raw.name,
      mimeType: raw.mimeType,
      size: raw.size ? Number(raw.size) : null,
      createdTime: raw.createdTime ?? null,
      modifiedTime: raw.modifiedTime ?? null,
      owners: raw.owners ? raw.owners.map((o: any) => ({ displayName: o.displayName ?? null, emailAddress: o.emailAddress ?? null })) : null,
      parents: raw.parents ?? null,
      webViewLink: raw.webViewLink ?? null,
      iconLink: raw.iconLink ?? null,
      thumbnailLink: raw.thumbnailLink ?? null,
      isFolder: raw.mimeType === "application/vnd.google-apps.folder",
    };
  }

  static async getFile(fileId: string): Promise<DriveFile> {
    glogger.info("DriveService: getFile request received", { fileId });
    const { client, integration } = await DriveService.createClientForUser();
    try {
      // check cache via centralized google cache
      const store = googleCache.getIntegrationStore(integration.id);
      const filesMap = store.get<Map<string, { file: DriveFile; ts: number }>>("files");
      const cached = filesMap?.get(fileId);
      if (cached && Date.now() - cached.ts < CACHE_MS) {
        glogger.debug("DriveService: returning cached file metadata", { fileId });
        return cached.file;
      }

      const res = await client.getFile(fileId);
      const f = DriveService.toDriveFile(res);

      // cache
      const filesMap2 = filesMap ?? new Map<string, { file: DriveFile; ts: number }>();
      filesMap2.set(f.id, { file: f, ts: Date.now() });
      store.set("files", filesMap2, CACHE_MS);

      glogger.info("DriveService: file returned", { fileId: f.id });
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Viewed File",
        details: `Viewed file ${f.name ?? fileId}`,
        integrationId: integration.id,
      }).catch((e) => glogger.debug("logActivity failed", { error: String(e) }));
      return f;
    } catch (err: any) {
      glogger.error("DriveService: getFile failed", { fileId, error: String(err) });
      if (err instanceof AppError) throw err;
      const status = err?.status ?? err?.statusCode ?? null;
      // Try to extract the real Google API error from the response body before it is lost
      let body: any = undefined;
      try { if (typeof err?.json === "function") body = await err.json(); } catch {}
      if (status === 404) throw new AppError("File not found", 404, "not_found");
      if (status === 403) throw mapStatusToAppError(status, body);
      if (status === 401) { try { await tokenManager.invalidate(integration.id); } catch {} }
      throw mapStatusToAppError(status, body);
    }
  }

  static async searchFiles(q: string, pageSize?: number, pageToken?: string) {
    glogger.info("DriveService: searchFiles request received", { q, pageSize });
    const { client, integration } = await DriveService.createClientForUser();
    try {
      const res = await client.searchFiles(q, pageSize, pageToken);
      const files = (res.files ?? []).map((f: any) => DriveService.toDriveFile(f));

      // cache in centralized google cache
      const store = googleCache.getIntegrationStore(integration.id);
      let filesMap = store.get<Map<string, { file: DriveFile; ts: number }>>("files");
      if (!filesMap) {
        filesMap = new Map<string, { file: DriveFile; ts: number }>();
      }
      files.forEach((f: DriveFile) => filesMap!.set(f.id, { file: f, ts: Date.now() }));
      store.set("files", filesMap, CACHE_MS);

      const nextPageToken = res.nextPageToken ?? null;
      glogger.info("DriveService: searchFiles returned", { count: files.length });
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Searched Drive",
        details: q ? `Searched for "${q}"` : `Listed ${files.length} files`,
        integrationId: integration.id,
      }).catch((e) => glogger.debug("logActivity failed", { error: String(e) }));
      return { files, nextPageToken };
    } catch (err: any) {
      glogger.error("DriveService: searchFiles failed", { error: String(err) });
      if (err instanceof AppError) throw err;
      const status = err?.status ?? err?.statusCode ?? null;
      // Try to extract the real Google API error from the response body before it is lost
      let body: any = undefined;
      try { if (typeof err?.json === "function") body = await err.json(); } catch {}
      if (status === 401 ) { try { await tokenManager.invalidate(integration.id); } catch {} }
      throw mapStatusToAppError(status, body);
    }
  }

  static async listFolders(pageSize?: number, pageToken?: string) {
    glogger.info("DriveService: listFolders request received");
    const { client, integration } = await DriveService.createClientForUser();
    try {
      const store = googleCache.getIntegrationStore(integration.id);
      const cachedFolders = store.get<DriveFolder[]>("folders");
      if (cachedFolders) {
        glogger.debug("DriveService: returning cached folders", { integrationId: integration.id, count: cachedFolders.length });
        return { files: cachedFolders, nextPageToken: null };
      }

      const res = await client.listFolders({ pageSize, pageToken });
      const folders = (res.files ?? []).map((f: any) => ({ id: f.id, name: f.name, parents: f.parents ?? null, createdTime: f.createdTime ?? null }));
      store.set("folders", folders, CACHE_MS);
      glogger.info("DriveService: folders fetched and cached", { count: folders.length });
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Listed Folders",
        details: `Listed ${folders.length} folders`,
        integrationId: integration.id,
      }).catch((e) => glogger.debug("logActivity failed", { error: String(e) }));
      return { files: folders, nextPageToken: res.nextPageToken ?? null };
    } catch (err: any) {
      glogger.error("DriveService: listFolders failed", { error: String(err) });
      if (err instanceof AppError) throw err;
      const status = err?.status ?? err?.statusCode ?? null;
      // Try to extract the real Google API error from the response body before it is lost
      let body: any = undefined;
      try { if (typeof err?.json === "function") body = await err.json(); } catch {}
      if (status === 401 ) { try { await tokenManager.invalidate(integration.id); } catch {} }
      throw mapStatusToAppError(status, body);
    }
  }

  static async getAbout() {
    glogger.info("DriveService: getAbout request received");
    const { client } = await DriveService.createClientForUser();
    try {
      const res = await client.getAbout();
      return res;
    } catch (err: any) {
      glogger.error("DriveService: getAbout failed", { error: String(err) });
      if (err instanceof AppError) throw err;
      const status = err?.status ?? err?.statusCode ?? null;
      // Try to extract the real Google API error from the response body before it is lost
      let body: any = undefined;
      try { if (typeof err?.json === "function") body = await err.json(); } catch {}
      throw mapStatusToAppError(status, body);
    }
  }
}

export default DriveService;