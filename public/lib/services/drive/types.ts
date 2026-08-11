export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: number | null;
  createdTime?: string | null; // ISO
  modifiedTime?: string | null; // ISO
  owners?: Array<{ displayName?: string; emailAddress?: string }> | null;
  parents?: string[] | null;
  webViewLink?: string | null;
  iconLink?: string | null;
  thumbnailLink?: string | null;
  isFolder: boolean;
};

export type DriveFolder = {
  id: string;
  name: string;
  parents?: string[] | null;
  createdTime?: string | null;
};

export type ListFilesResult = {
  files: DriveFile[];
  nextPageToken?: string | null;
};