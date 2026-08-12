/**
 * AI layer — Google Drive tools.
 *
 * Three tools that reuse the existing production `DriveService`:
 *
 * - `drive.searchFiles`    → real matching files via Drive search
 * - `drive.recentFiles`    → recently modified files, sorted by modified time
 * - `drive.summarizeDocument` → file metadata only
 *
 * Content limitation (honest, never pretended): the existing Drive service
 * exposes file *metadata* only (name, mimeType, modifiedTime, owners, …) —
 * it has no file-text/content endpoint. `drive.summarizeDocument` therefore
 * returns the real metadata with `contentAvailable: false`; it does NOT
 * claim to summarize PDF/DOCX text that the integration cannot read.
 */

import { z } from "zod";
import type { Tool } from "@/lib/tools/types";
import DriveService from "@/lib/services/drive";
import type { DriveFile, ListFilesResult } from "@/lib/services/drive/types";
import { AppError } from "@/lib/errors";
import { toolSuccess, type AIToolResult, type AIToolSource } from "./types";

/** Default / maximum number of files a tool fetches. */
const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS = 50;

const filesInputSchema = z.object({
  maxResults: z.number().int().min(1).max(MAX_RESULTS).optional(),
});

const searchFilesInputSchema = z.object({
  /** Free-text Drive search query (same syntax as the Drive search box). */
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(MAX_RESULTS).optional(),
});

const summarizeDocumentInputSchema = z.object({
  /** Drive file id; defaults to the most recently modified file. */
  fileId: z.string().min(1).optional(),
});

export type FilesToolInput = z.infer<typeof filesInputSchema>;
export type SearchFilesInput = z.infer<typeof searchFilesInputSchema>;
export type SummarizeDocumentInput = z.infer<typeof summarizeDocumentInputSchema>;

/**
 * Minimal structural surface of the production Drive service used by the
 * tools (mirrors `lib/services/drive/driveService.ts`).
 */
export interface DriveToolService {
  listFiles(params?: { pageSize?: number; pageToken?: string; folderId?: string }): Promise<ListFilesResult>;
  searchFiles(q: string, pageSize?: number, pageToken?: string): Promise<ListFilesResult>;
  getFile(fileId: string): Promise<DriveFile>;
}

/** Normalize a file's metadata for display + LLM context. */
export function toFileSummary(file: DriveFile) {
  return {
    id: file.id,
    name: file.name ?? "",
    mimeType: file.mimeType ?? "",
    size: file.size ?? null,
    modifiedTime: file.modifiedTime ?? null,
    createdTime: file.createdTime ?? null,
    owner: file.owners?.[0]?.displayName ?? file.owners?.[0]?.emailAddress ?? null,
    webViewLink: file.webViewLink ?? null,
    isFolder: file.isFolder,
  };
}

/** Source reference for a file. */
function fileSource(file: DriveFile): AIToolSource {
  return {
    integration: "drive",
    type: file.isFolder ? "folder" : "file",
    id: file.id,
    title: file.name ?? undefined,
    url: file.webViewLink ?? undefined,
  };
}

/** Sort files by modified time descending (most recent first). */
export function sortByModifiedDesc(files: readonly DriveFile[]): DriveFile[] {
  return [...files].sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""));
}

/** Search the user's Drive files. */
export class DriveSearchFilesTool implements Tool {
  readonly id = "drive.searchFiles";
  readonly description = "Search the user's Google Drive files by query text.";
  readonly inputSchema = searchFilesInputSchema;

  constructor(private readonly service: DriveToolService = DriveService) {}

  async execute(input: SearchFilesInput): Promise<AIToolResult> {
    const result = await this.service.searchFiles(input.query, input.maxResults ?? DEFAULT_MAX_RESULTS);
    const files = result.files;
    return toolSuccess(
      this.id,
      {
        query: input.query,
        count: files.length,
        files: files.map(toFileSummary),
      },
      files.map(fileSource),
    );
  }
}

/** List the user's recently modified Drive files. */
export class DriveRecentFilesTool implements Tool {
  readonly id = "drive.recentFiles";
  readonly description = "List the user's recently modified Google Drive files.";
  readonly inputSchema = filesInputSchema;

  constructor(private readonly service: DriveToolService = DriveService) {}

  async execute(input: FilesToolInput): Promise<AIToolResult> {
    const result = await this.service.listFiles({ pageSize: input.maxResults ?? DEFAULT_MAX_RESULTS });
    const files = sortByModifiedDesc(result.files);
    return toolSuccess(
      this.id,
      {
        count: files.length,
        files: files.map(toFileSummary),
      },
      files.map(fileSource),
    );
  }
}

/**
 * Fetch a Drive file's metadata for summarization.
 *
 * The existing Drive service provides metadata only — the tool returns
 * `contentAvailable: false` and a clear message instead of pretending to
 * read the document text. The orchestrator explains this honestly to the
 * user.
 */
export class DriveSummarizeDocumentTool implements Tool {
  readonly id = "drive.summarizeDocument";
  readonly description = "Fetch a Drive file's metadata (document text is not available via the current integration).";
  readonly inputSchema = summarizeDocumentInputSchema;

  constructor(private readonly service: DriveToolService = DriveService) {}

  async execute(input: SummarizeDocumentInput): Promise<AIToolResult> {
    let file: DriveFile;
    if (input.fileId) {
      file = await this.service.getFile(input.fileId);
    } else {
      const result = await this.service.listFiles({ pageSize: 1 });
      const mostRecent = result.files[0];
      if (!mostRecent) {
        throw new AppError("No files found", 404, "no_files_found");
      }
      file = mostRecent;
    }
    return toolSuccess(
      this.id,
      {
        file: toFileSummary(file),
        contentAvailable: false,
        message:
          "The current Drive integration returns file metadata only — document text cannot be fetched, so a content summary is not available.",
      },
      [fileSource(file)],
    );
  }
}
