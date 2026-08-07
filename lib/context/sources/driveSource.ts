/**
 * Context Engine — Drive context source.
 *
 * `DriveSource` is the fifth real `ContextSource`: it retrieves relevant
 * Drive files from a Drive service and converts each file into a `Context`
 * object consumed by the pipeline.
 *
 * Note: the repository may contain Drive-related services; they are ignored
 * unless they already expose exactly this contract. This module defines the
 * minimal structural contract (`DriveService` / `DriveFile`) in-file, and the
 * future adapter must satisfy that shape.
 *
 * Type note: the spec maps `metadata.kind` to the source-level literal
 * `"drive"`, which is not a member of `ContextMetadata["kind"]` in
 * `lib/context/types.ts` (which uses the semantic kind `"file"`), and adds
 * `mimeType`/`path` metadata fields that `ContextMetadata` does not declare.
 * Since no existing file may be modified, the extended `DriveMetadata`
 * intersection documents those extra fields and a single targeted assertion
 * supplies the `"drive"` kind; every other field remains fully type-checked.
 */

import type { Context, ContextMetadata, RetrievalQuery } from "@/lib/context/types";
import { estimateTokens } from "@/lib/context/tokenBudget";
import { ContextSourceBase } from "./contextSource";

/** Source id used by `DriveSource`. */
export const DRIVE_SOURCE_ID = "drive";

/** Default priority of `DriveSource` relative to other sources. */
export const DRIVE_SOURCE_PRIORITY = 20;

/** Default relevance used when a file carries no relevance score. */
export const DEFAULT_DRIVE_FILE_RELEVANCE = 0.5;

/** Importance levels shared with the context pipeline. */
export type ContextImportance = "low" | "normal" | "high" | "critical";

/** "drive" is a source-level kind; `ContextMetadata.kind` lacks the literal. */
const DRIVE_METADATA_KIND = "drive" as unknown as ContextMetadata["kind"];

/**
 * Metadata of a Drive context item: `ContextMetadata` plus the Drive
 * source-specific fields the spec maps (`mimeType`, `path`).
 */
export type DriveMetadata = ContextMetadata & {
  /** MIME type of the file, when known. */
  mimeType?: string;
  /** Path (folder structure) of the file, when known. */
  path?: string;
};

/**
 * A single Drive file returned by a `DriveService`.
 */
export interface DriveFile {
  /** Stable provider-side id of the file. */
  id: string;
  /** File name. */
  title: string;
  /** File text content that will be sent to the LLM. */
  content: string;
  /** ISO timestamp of the file, or null/undefined when unknown. */
  timestamp?: string | null;
  /** Relevance score in [0, 1]; 0.5 is assumed when missing. */
  relevance?: number;
  /** MIME type of the file, when known. */
  mimeType?: string;
  /** Path (folder structure) of the file, when known. */
  path?: string;
  /** Human-readable owner of the file, when known. */
  owner?: string;
  /** Importance used during ranking. */
  importance?: ContextImportance;
}

/**
 * Contract for the Drive service consumed by `DriveSource`.
 *
 * The service decides how files are searched and ranked for relevance.
 * `DriveSource` only depends on this surface.
 */
export interface DriveService {
  /** Whether Drive is available for the user right now. */
  isAvailable(userId: string): Promise<boolean>;
  /**
   * Return the files most relevant to a query, in relevance order
   * (best first). Implementations may use the query, conversation history,
   * and an item cap.
   */
  retrieveRelevantFiles(args: {
    userId: string;
    query: string;
    history?: readonly string[];
    maxItems?: number;
  }): Promise<DriveFile[]>;
}

/**
 * Fifth real context source: retrieves relevant Drive files and maps them to
 * `Context` items.
 */
export class DriveSource extends ContextSourceBase {
  private readonly service: DriveService;

  constructor(service: DriveService) {
    super(DRIVE_SOURCE_ID, DRIVE_SOURCE_PRIORITY);
    this.service = service;
  }

  /**
   * Whether Drive is available for the user — delegated to the service.
   */
  async isAvailable(userId: string): Promise<boolean> {
    return this.service.isAvailable(userId);
  }

  /**
   * Retrieve relevant files and map them to `Context` items.
   *
   * - The service is called with `userId`, `query`, `history`, and `maxItems`
   *   from the retrieval query (missing optional fields forwarded as
   *   `undefined`).
   * - Every returned file is mapped to a new `Context` with `source`
   *   `"drive"`, `metadata.kind` `"drive"`, `metadata.entityId` set to the
   *   file id, `mimeType`/`path`/`author` (from `owner`)/`importance` copied
   *   through, `metadata.raw` set to the original file object (by
   *   reference), and `permissions` `null`. `tokenEstimate` uses
   *   `estimateTokens(content)`; a missing timestamp maps to `null` and a
   *   missing relevance to 0.5.
   * - Input order is preserved.
   * - A throwing service yields `[]` (never throws, no logging, no retries).
   * - Inputs are never mutated; each returned item is a new object.
   */
  async retrieve(query: RetrievalQuery): Promise<Context[]> {
    let files: DriveFile[];
    try {
      files = await this.service.retrieveRelevantFiles({
        userId: query.userId,
        query: query.query,
        history: query.history,
        maxItems: query.maxItems,
      });
    } catch {
      return [];
    }
    return files.map((file) => this.toContext(file));
  }

  /** Map a file to a `Context` object (new object, no mutation). */
  private toContext(file: DriveFile): Context {
    const metadata: DriveMetadata = {
      kind: DRIVE_METADATA_KIND,
      entityId: file.id,
      mimeType: file.mimeType,
      path: file.path,
      author: file.owner,
      importance: file.importance,
      raw: file,
    };

    return {
      id: file.id,
      source: DRIVE_SOURCE_ID,
      title: file.title,
      content: file.content,
      timestamp: file.timestamp ?? null,
      relevance: file.relevance ?? DEFAULT_DRIVE_FILE_RELEVANCE,
      tokenEstimate: estimateTokens(file.content),
      truncated: false,
      compressed: false,
      metadata,
      permissions: null,
    };
  }
}
