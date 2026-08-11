/**
 * Context Engine — Drive service adapter.
 *
 * Bridges the repository's production drive service
 * (`lib/services/drive/driveService.ts`) to the `DriveService` contract
 * consumed by `DriveSource`.
 *
 * The production service is a request-scoped static API: it derives the
 * current user from the request context and exposes `createClientForUser`,
 * `listFiles`, and `searchFiles` (returning `DriveFile` metadata summaries).
 * The contract surface differs, so this adapter performs pure delegation plus
 * field mapping:
 *
 * - `isAvailable` probes the production service's client creation; any
 *   failure (unauthenticated, integration not connected, invalid token)
 *   means Drive is unavailable for the user.
 * - `retrieveRelevantFiles` delegates to `searchFiles` when a query is
 *   provided and to `listFiles` otherwise, then maps each production
 *   `DriveFile` into the `DriveFile` contract shape — ordering preserved, no
 *   filtering, no reranking, no deduplication, no truncation.
 *
 * Service failures are forwarded, never swallowed; `DriveSource` already
 * converts retrieval failures into an empty result. Because the production
 * service is request-scoped, the `userId` accepted by the contract is not
 * forwarded to it.
 *
 * Field notes:
 * - `content`: the production service exposes file metadata only (name,
 *   mimeType, modifiedTime, owners, parents, ...) — no file text. The
 *   contract requires a `content` string, so it maps to `""` (the neutral
 *   empty representation) until a content-fetching endpoint exists.
 * - `path`: production has no `path` field; `path` derives from the
 *   `parents` array (folder hierarchy ids) joined with "/", and is omitted
 *   when absent.
 */

import DriveService from "@/lib/services/drive";
import type { DriveFile as ProductionDriveFile, ListFilesResult } from "@/lib/services/drive/types";
import type {
  DriveFile,
  DriveService as DriveServiceContract,
} from "@/lib/context/sources/driveSource";

/**
 * Minimal structural surface of the production drive service that the adapter
 * depends on. Mirrors the static members of `lib/services/drive/driveService.ts`.
 */
export interface ProductionDriveService {
  /** Resolve the current user's drive client and integration (throws when unavailable). */
  createClientForUser(): Promise<unknown>;
  /** List recent files for the current user. */
  listFiles(params?: { pageSize?: number; pageToken?: string; folderId?: string }): Promise<ListFilesResult>;
  /** Search files for the current user. */
  searchFiles(q: string, pageSize?: number, pageToken?: string): Promise<ListFilesResult>;
}

/**
 * Pure adapter exposing the `DriveSource`-required `DriveService` contract
 * over the production drive service.
 */
export class DriveServiceAdapter implements DriveServiceContract {
  private readonly service: ProductionDriveService;

  constructor(service: ProductionDriveService = DriveService) {
    this.service = service;
  }

  /**
   * Whether Drive is available for the user.
   *
   * Delegates to the production service by attempting to create a client for
   * the current user. Any failure (unauthenticated, integration not
   * connected, invalid token) means Drive is unavailable. No caching, no
   * retries, no logging.
   *
   * The production service resolves the user from the request context, so
   * the contract's `userId` is not forwarded to it.
   */
  async isAvailable(userId: string): Promise<boolean> {
    // The production service resolves the user from the request context, so
    // the contract's `userId` is not forwarded to it.
    void userId;
    try {
      await this.service.createClientForUser();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retrieve the files most relevant to a query.
   *
   * A non-empty query is delegated to `searchFiles(query, maxItems)` (query
   * passed verbatim; `maxItems` fills the `pageSize` parameter — the second
   * production parameter); an empty/blank query lists recent files via
   * `listFiles({ pageSize: maxItems })`. The production response is mapped
   * field-by-field into `DriveFile` objects, preserving order. No filtering,
   * no reranking, no deduplication, no truncation.
   *
   * Service failures are forwarded (never swallowed); `DriveSource` handles
   * them by returning `[]`.
   */
  async retrieveRelevantFiles(args: {
    userId: string;
    query: string;
    history?: readonly string[];
    maxItems?: number;
  }): Promise<DriveFile[]> {
    const { query, maxItems } = args;
    const result =
      query.trim().length > 0
        ? await this.service.searchFiles(query, maxItems)
        : await this.service.listFiles({ pageSize: maxItems });
    return result.files.map((file) => this.toFile(file));
  }

  /**
   * Map a production `DriveFile` metadata summary to the `DriveFile` contract.
   *
   * - `title` maps to the production `name`; a missing value normalizes to an
   *   empty string.
   * - `content` maps to `""` — the production service exposes no file text.
   * - `timestamp` maps to the production `modifiedTime`; a missing timestamp
   *   maps to `undefined`.
   * - `path` derives from the `parents` folder-hierarchy ids joined with
   *   "/", omitted when absent.
   * - `owner` maps to the first production owner's `displayName`, falling
   *   back to its `emailAddress` when the display name is missing or empty;
   *   a missing owner maps to `undefined`.
   * - `relevance` and `importance` are not produced by the service and are
   *   intentionally omitted (never invented); `DriveSource` defaults
   *   relevance to 0.5.
   */
  private toFile(file: ProductionDriveFile): DriveFile {
    return {
      id: file.id,
      title: file.name ?? "",
      content: "",
      timestamp: file.modifiedTime ?? undefined,
      mimeType: file.mimeType ?? undefined,
      path: file.parents?.join("/") || undefined,
      owner: this.ownerToString(file.owners),
    };
  }

  /** Reduce the production owners list to a single display string. */
  private ownerToString(owners: ProductionDriveFile["owners"]): string | undefined {
    const owner = owners?.[0];
    if (!owner) return undefined;
    // `||` (not `??`) so an empty-string displayName falls back to the email.
    return owner.displayName || owner.emailAddress || undefined;
  }
}
