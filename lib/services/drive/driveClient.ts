import { safeFetch } from "@/lib/services/google-http";

const BASE = "https://www.googleapis.com/drive/v3";

export class DriveClient {
  accessToken: string;
  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private headers() {
    return { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" } as Record<string, string>;
  }

  // list files with q, pageSize, pageToken; fields minimized
  async listFiles(params: { q?: string; pageSize?: number; pageToken?: string; orderBy?: string }) {
    const url = new URL(`${BASE}/files`);
    if (params.q) url.searchParams.set("q", params.q);
    if (params.pageSize) url.searchParams.set("pageSize", String(params.pageSize));
    if (params.pageToken) url.searchParams.set("pageToken", params.pageToken);
    if (params.orderBy) url.searchParams.set("orderBy", params.orderBy);
    // request only metadata fields needed
    url.searchParams.set("fields", "files(id,name,mimeType,size,createdTime,modifiedTime,owners(emailAddress,displayName),parents,webViewLink,iconLink,thumbnailLink),nextPageToken");

    const res = await safeFetch(url.toString(), { method: "GET", headers: this.headers() }, { url: url.pathname });
    if (!res.ok) throw res;
    return res.json();
  }

  // get single file metadata
  async getFile(fileId: string) {
    const url = new URL(`${BASE}/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set("fields", "id,name,mimeType,size,createdTime,modifiedTime,owners(emailAddress,displayName),parents,webViewLink,iconLink,thumbnailLink");
    const res = await safeFetch(url.toString(), { method: "GET", headers: this.headers() }, { url: url.pathname, fileId });
    if (!res.ok) throw res;
    return res.json();
  }

  // list folders (q by mimeType) with optional parent filter
  async listFolders(params: { parentId?: string; pageSize?: number; pageToken?: string }) {
    // query for folders
    let q = "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    if (params.parentId) q += ` and '${params.parentId}' in parents`;
    return this.listFiles({ q, pageSize: params.pageSize, pageToken: params.pageToken });
  }

  // search files by query (Drive search syntax similar to Gmail q) - pass-through
  async searchFiles(q: string, pageSize?: number, pageToken?: string) {
    return this.listFiles({ q, pageSize, pageToken });
  }

  // optional about.get
  async getAbout() {
    const url = new URL(`${BASE}/about`);
    url.searchParams.set("fields", "user,storageQuota,kind");
    const res = await safeFetch(url.toString(), { method: "GET", headers: this.headers() }, { url: url.pathname });
    if (!res.ok) throw res;
    return res.json();
  }
}
