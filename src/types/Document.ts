/**
 * Document and Page type definitions for multi-page document support.
 */

import { Shape } from '../shapes/Shape';
import { RichTextContent } from './RichText';
import type { RichTextPage } from '../store/richTextPagesStore';
import type { WhiteboardState } from './Whiteboard';
import type { PDFSettings } from './PDFExport';
import type { ReferenceLibrary } from './Citation';
import type { FieldLibrary } from './Field';

/**
 * A single page within a document.
 * Each page has its own shapes and z-order.
 */
export interface Page {
  /** Unique page identifier */
  id: string;
  /** Display name of the page */
  name: string;
  /** Shapes on this page, keyed by ID */
  shapes: Record<string, Shape>;
  /** Z-order of shapes (first = bottom, last = top) */
  shapeOrder: string[];
  /** Timestamp when page was created */
  createdAt: number;
  /** Timestamp when page was last modified */
  modifiedAt: number;
}

/**
 * A complete diagram document containing multiple pages.
 */
export interface DiagramDocument {
  /** Unique document identifier */
  id: string;
  /** Display name of the document */
  name: string;
  /** All pages in the document, keyed by ID */
  pages: Record<string, Page>;
  /** Order of pages (for tab display) */
  pageOrder: string[];
  /** Currently active page ID */
  activePageId: string;
  /** Timestamp when document was created */
  createdAt: number;
  /** Timestamp when document was last modified */
  modifiedAt: number;
  /** Schema version for migration support */
  version: number;
  /** Rich text document content (optional for backwards compatibility) */
  richTextContent?: RichTextContent;
  /** Rich text pages (multi-page support) */
  richTextPages?: {
    pages: Record<string, RichTextPage>;
    pageOrder: string[];
    activePageId: string | null;
  };
  /** Blob IDs referenced by this document (for garbage collection) */
  blobReferences?: string[];

  // Citations (JP-89)
  /**
   * Per-document reference library (CSL-JSON), the backing store for inline
   * citations + the bibliography block. Optional for backwards compatibility:
   * an older document simply has no `references` key and loads as an empty
   * library (mirrors how `richTextPages` was introduced — additive, no
   * `DOCUMENT_VERSION` bump). Plain JSON, so it rides the normal save/load and
   * relay-flatten paths with no special handling.
   */
  references?: ReferenceLibrary;

  // Document Fields (Phase 3)
  /**
   * Per-document field library — reusable `{{name}}` values (defined terms,
   * versions, etc.). Optional for backwards compatibility: an older document
   * has no `fields` key and loads as an empty library (additive, like
   * `references` — no `version` bump). Plain JSON, so it rides the normal
   * save/load and relay-flatten paths unchanged, and is the exact shape a
   * future MCP `set_fields` tool will write.
   */
  fields?: FieldLibrary;

  // Collection membership (JP-159)
  /**
   * The id of the collection this document belongs to ("workspace inside your
   * workspace"), or absent for unassigned. Additive/optional like `references`/
   * `fields` — no `version` bump, no migration. This is a **transport-only
   * membership stamp**: the relay-save boundary stamps it from `collectionStore`
   * (the canonical client model) so a content-save can't erase the relay's
   * `collectionId`; the relay lifts it into `DocumentMetadata`. The editor's
   * document-construction path does not author it.
   */
  collectionId?: string;

  // Team document fields (Phase 14.1)
  /** Whether this is a relay document (stored on host, synced via CRDT) */
  isRelayDocument?: boolean;
  /** User ID who currently has the document locked for editing */
  lockedBy?: string;
  /** Display name of user who locked the document */
  lockedByName?: string;
  /** Timestamp when document was locked */
  lockedAt?: number;
  /** User ID who owns this document */
  ownerId?: string;
  /** Display name of the owner */
  ownerName?: string;
  /** Users with shared access to this document */
  sharedWith?: DocumentShare[];
  /** User ID who last modified this document */
  lastModifiedBy?: string;
  /** Display name of user who last modified */
  lastModifiedByName?: string;

  // Version tracking fields (Phase 14.9.2)
  /** Server-confirmed version for conflict detection */
  serverVersion?: number;

  // Whiteboard fields (Phase 18.3)
  /** Whiteboard state for sticky notes */
  whiteboard?: WhiteboardState;

  // PDF export settings (Phase 19.3)
  /**
   * Per-document PDF export overrides. Optional — when absent, the PDF
   * export dialog falls back to app-level defaults from `usePDFExportStore`.
   * Stored per-document so one user's preferred margins / cover-page
   * choices don't bleed into unrelated documents on next open.
   */
  pdfSettings?: PDFSettings;
}

/**
 * Document share entry for tracking who has access.
 */
export interface DocumentShare {
  /** User ID */
  userId: string;
  /** User display name */
  userName: string;
  /** Permission level */
  permission: 'view' | 'edit';
  /** When the share was created */
  sharedAt: number;
}

/**
 * Lightweight metadata for document listing.
 * Used in the document index to avoid loading full documents.
 */
export interface DocumentMetadata {
  /** Unique document identifier */
  id: string;
  /** Display name of the document */
  name: string;
  /** Total pages across both collections — canvas pages + prose pages (JP-349). */
  pageCount: number;
  /** Timestamp when document was last modified */
  modifiedAt: number;
  /** Timestamp when document was created */
  createdAt: number;

  // Team document fields (Phase 14.1)
  /** Whether this is a relay document */
  isRelayDocument?: boolean;
  /** User ID who currently has the document locked */
  lockedBy?: string;
  /** Display name of user who locked it */
  lockedByName?: string;
  /** Timestamp when document was locked */
  lockedAt?: number;
  /** User ID who owns this document */
  ownerId?: string;
  /** Display name of the owner */
  ownerName?: string;
  /** Users with shared access */
  sharedWith?: DocumentShare[];
  /** User ID who last modified */
  lastModifiedBy?: string;
  /** Display name of who last modified */
  lastModifiedByName?: string;
  /** Collection membership (JP-159); absent = unassigned. Lifted by the relay
   *  from the document body's `collectionId`. */
  collectionId?: string;
}

/**
 * Snapshot of page content for serialization.
 */
export interface PageSnapshot {
  shapes: Record<string, Shape>;
  shapeOrder: string[];
}

/**
 * Current document schema version.
 * Increment when making breaking changes to the document structure.
 *
 * History:
 * - v1: original DocuShark (v2) document format.
 * - v2 (JP-347): pre-GA posture hardening — group `ownerId` is normalized to an
 *   explicit `null` (never `undefined`) and the active page ids (canvas + prose)
 *   are self-healed to reference a real page. See `migrations/documentMigrations.ts`.
 */
export const DOCUMENT_VERSION = 2;

/**
 * localStorage keys for document persistence.
 */
export const STORAGE_KEYS = {
  /** Index of all saved documents (DocumentMetadata[]) */
  DOCUMENT_INDEX: 'docushark-documents',
  /** Prefix for individual document storage */
  DOCUMENT_PREFIX: 'docushark-doc-',
  /** ID of the last opened document */
  CURRENT_DOCUMENT: 'docushark-current-doc',
} as const;

/**
 * Create a new empty page with default values.
 */
export function createPage(name: string, id: string): Page {
  const now = Date.now();
  return {
    id,
    name,
    shapes: {},
    shapeOrder: [],
    createdAt: now,
    modifiedAt: now,
  };
}

/**
 * Create a new empty document with a single page.
 */
export function createDocument(name: string, docId: string, pageId: string): DiagramDocument {
  const now = Date.now();
  const firstPage = createPage('Canvas', pageId);

  return {
    id: docId,
    name,
    pages: { [pageId]: firstPage },
    pageOrder: [pageId],
    activePageId: pageId,
    createdAt: now,
    modifiedAt: now,
    version: DOCUMENT_VERSION,
  };
}

/**
 * Extract metadata from a full document.
 */
export function getDocumentMetadata(doc: DiagramDocument): DocumentMetadata {
  const metadata: DocumentMetadata = {
    id: doc.id,
    name: doc.name,
    // JP-349: canvas + prose total, matching the relay's metadata derivation so
    // the "N pages" UI and the server-listed count agree.
    pageCount: doc.pageOrder.length + (doc.richTextPages?.pageOrder.length ?? 0),
    modifiedAt: doc.modifiedAt,
    createdAt: doc.createdAt,
  };

  // Only include relay document fields if they are defined
  if (doc.isRelayDocument !== undefined) {
    metadata.isRelayDocument = doc.isRelayDocument;
  }
  if (doc.lockedBy !== undefined) {
    metadata.lockedBy = doc.lockedBy;
  }
  if (doc.lockedByName !== undefined) {
    metadata.lockedByName = doc.lockedByName;
  }
  if (doc.lockedAt !== undefined) {
    metadata.lockedAt = doc.lockedAt;
  }
  if (doc.ownerId !== undefined) {
    metadata.ownerId = doc.ownerId;
  }
  if (doc.ownerName !== undefined) {
    metadata.ownerName = doc.ownerName;
  }
  if (doc.sharedWith !== undefined) {
    metadata.sharedWith = doc.sharedWith;
  }
  if (doc.lastModifiedBy !== undefined) {
    metadata.lastModifiedBy = doc.lastModifiedBy;
  }
  if (doc.lastModifiedByName !== undefined) {
    metadata.lastModifiedByName = doc.lastModifiedByName;
  }

  return metadata;
}
