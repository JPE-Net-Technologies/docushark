/**
 * Persistence store for document saving/loading with localStorage.
 *
 * Manages document persistence, auto-save, and document index.
 * Each document is stored separately to avoid localStorage size limits.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { nanoid } from 'nanoid';
import {
  DiagramDocument,
  DocumentMetadata,
  STORAGE_KEYS,
  getDocumentMetadata,
} from '../types/Document';
import { validateDocumentJSON } from '../types/DocumentValidation';
import { usePageStore, PageStoreSnapshot } from './pageStore';
import { useNotificationStore } from './notificationStore';
import type { Page } from '../types/Document';
import { useRichTextStore } from './richTextStore';
import { useRichTextPagesStore } from './richTextPagesStore';
import { useReferenceStore } from './referenceStore';
import { useFieldStore } from './fieldStore';
import { useUserStore } from './userStore';
import { isRelayAuthenticated, useConnectionStore } from './connectionStore';
import { useRelayDocumentStore } from './relayDocumentStore';
import { RelayDocumentCache } from '../storage/RelayDocumentCache';
import { getSyncStateManager } from '../collaboration/SyncStateManager';
import { useSessionStore } from './sessionStore';
import { useHistoryStore } from './historyStore';
import { useDocumentRegistry } from './documentRegistry';
import { useTrashStore } from './trashStore';
import { isRemoteDocument, isCachedDocument } from '../types/DocumentRegistry';
import { isCollabContentDoc, ensureCollabSessionForDoc, useCollaborationStore } from '../collaboration';
import { useWhiteboardStore } from './whiteboardStore';
import { blobStorage } from '../storage/BlobStorage';
import { collectBlobReferences } from '../storage/AssetBundler';
import { extractRichTextBlobIds, extractShapeBlobIds } from '../utils/richTextBlobExtractor';
import { withAutoSaveSuppressed, flushAutoSaveNow } from './autoSaveGuard';
import { VersionConflictError } from '../api/relayClient';
import { resetFileThumbnailCaches } from '../shapes/FileShape';

/**
 * Auto-save debounce time in milliseconds.
 */
export const AUTO_SAVE_DEBOUNCE = 2000;

/**
 * Resolve the relay a document belongs to (its *home* relay), independent of
 * whichever relay is currently connected. Origin is tracked on the document
 * record (`RemoteDocument`/`CachedDocument.relayId`) and, durably, on the
 * persistent cache entry. We consult both because the registry is in-memory
 * and empty on a cold boot — the persistent cache is the only origin source
 * for an offline edit made before any connection this boot (the JP-106 case).
 *
 * Returns `undefined` when the doc has no known origin yet — a brand-new doc
 * not registered or cached, which is being created on the connected relay.
 */
function resolveHomeRelayId(docId: string): string | undefined {
  const record = useDocumentRegistry.getState().getRecord(docId);
  if (record && (isRemoteDocument(record) || isCachedDocument(record))) {
    return record.relayId;
  }
  return RelayDocumentCache.getMeta(docId)?.relayId ?? undefined;
}

/**
 * Push a relay document to *its own* relay, or — when that relay isn't the
 * one we're connected to, or we can't reach it — durably cache it and queue
 * the save under the document's home relay for replay when we next connect
 * there, instead of dropping the edit or writing it to the wrong relay.
 *
 * (JP-106: offline edits to relay docs were being lost because the live
 * `isRelayAuthenticated()` gate is false while offline, so the save was never
 * attempted and never queued. JP-117: saves ignored the doc's origin and went
 * to whichever relay was connected — a cross-relay data-integrity/leak risk.)
 *
 * Gating: any `isRelayDocument` — such a doc always has a relay home, so its
 * edits must be durable even when made offline *before any connection this
 * boot* (the in-memory `relayDocumentStore.authenticated` flag is not
 * persisted, so it is `false` on a cold boot until auth completes; gating on
 * it dropped exactly these edits).
 *
 * Routing: the cache+queue are always tagged with the doc's home relay (its
 * own `relayId`, falling back to the connected relay only for a brand-new doc
 * with no origin yet). We push immediately only when the doc's home *is* the
 * connected relay; if its home is a different relay we never push — we queue
 * under home so it replays on the next connection there. When offline, or on a
 * connectivity failure, we cache+queue directly. Genuine errors (auth, version
 * conflict) are logged, not queued.
 */
function pushRelaySaveOrQueue(doc: DiagramDocument, context: string): void {
  if (!doc.isRelayDocument) return;
  // JP-127 (data safety): pin the reconciled blob reference set onto the doc up
  // front so the cached + offline-queued snapshot — and any reconnect replay of
  // it — can never persist a ref-less version. A replayed save that dropped a
  // ref made the relay release the ACL and GC the bytes (orphaned the asset).
  // saveToHost recomputes the same set; this guarantees the *queued* copy matches.
  doc = { ...doc, blobReferences: collectBlobReferences(doc) };
  const relayStore = useRelayDocumentStore.getState();

  // JP-234 diagnostics (temporary): trace the blob-upload trigger on the relay
  // save path. If you don't see this line on a collab edit, the autosave isn't
  // reaching here (or a stale service-worker build is running).
  console.log(
    '[JP-234] pushRelaySaveOrQueue:',
    context,
    'doc=', doc.id,
    'collab=', isCollabContentDoc(doc.id),
    'blobRefs=', doc.blobReferences?.length ?? 0,
  );

  const home = resolveHomeRelayId(doc.id);
  const connected = useConnectionStore.getState().host?.address;
  // A brand-new doc with no origin yet is being created on the connected relay.
  const homeRelayId = home ?? connected ?? 'unknown';

  // JP-108 (relay sole writer): a doc in an active collab session is relay-owned
  // content — the CRDT sync + the relay's own persistence (JP-36 JSON + JP-108
  // binary) carry it. The client must NOT REST push or queue it: a queued LWW
  // snapshot would replay over the relay's merged state (clobber), and any REST
  // save bumps serverVersion, which strands the relay's binary Y.Doc sidecar
  // (→ prose + CRDT identity lost on the next hydrate). Keep only the local
  // cache so the doc still opens offline.
  if (isCollabContentDoc(doc.id)) {
    void RelayDocumentCache.put(doc, homeRelayId).catch((e) =>
      console.error('[persistenceStore] Failed to cache collab edit:', e),
    );
    // JP-234: the REST `saveToHost` is suppressed above for collab docs (the
    // relay is the sole writer), but that path is also the only blob byte
    // uploader (JP-118) — so a file added mid-collab would sync its FileShape
    // via CRDT while its bytes never reach the relay (→ 404 on a fresh fetch).
    // Push just the bytes here: content-addressed + immutable, so no doc save /
    // serverVersion bump / CRDT clobber. Best-effort; debounced by autosave and
    // deduped server-side.
    //
    // JP-237: gate on connection — offline, the every-2s autosave would otherwise
    // retry-storm HEAD/PUTs the relay can't receive, and the failing existence
    // HEAD makes BlobSyncService conservatively re-queue blobs that already exist
    // server-side. The local cache `put` above keeps the bytes durable; on
    // reconnect, `uploadCollabBlobs` re-runs for the active doc (collaborationStore
    // onAuthenticated) so anything added offline still reaches the relay.
    if (!isRelayAuthenticated()) {
      return;
    }
    console.log('[JP-234] collab branch: triggering uploadCollabBlobs for', doc.id);
    void relayStore
      .uploadCollabBlobs(doc)
      .then((result) => {
        if (result && result.failed > 0) {
          const detail = Array.from(result.errors.values())[0] ?? 'unknown error';
          console.warn(
            `[persistenceStore] collab blob upload: ${result.failed} of ${result.total} ` +
              `asset(s) for ${doc.id} failed: ${detail}`,
          );
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (/quota exceeded/i.test(message)) {
          useNotificationStore.getState().error(
            'A file you added is out of storage room and was not uploaded — it’s kept ' +
              'locally and will upload once you free up space.',
            { category: 'permanent' },
          );
        } else {
          console.warn('[persistenceStore] collab blob upload failed:', message);
        }
      });
    return;
  }

  const queueForReplay = (reason: string): void => {
    void RelayDocumentCache.put(doc, homeRelayId).catch((e) =>
      console.error('[persistenceStore] Failed to cache relay edit:', e),
    );
    getSyncStateManager().queueSave(doc, homeRelayId);
    console.warn(
      `[persistenceStore] ${reason} — cached + queued relay save under ${homeRelayId} for replay (${context})`,
    );
  };

  // We're connected to a relay that isn't this doc's home: never push it to
  // the connected relay. Queue under its home relay instead. (When there's no
  // connected relay at all, this falls through to the offline branch below.)
  if (connected !== undefined && home !== undefined && home !== connected) {
    queueForReplay('Doc belongs to another relay');
    return;
  }

  if (!isRelayAuthenticated()) {
    // Offline: don't attempt a push the relay can't receive.
    queueForReplay('Offline');
    return;
  }

  relayStore.saveToHost(doc).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: unknown }).status;

    // Terminal failures (JP-127): a blind replay can't fix these, so don't
    // queue — but never *silently* drop the edit. Surface it and keep the local
    // copy (reattach's newer-local guard stops a later clobber).
    if (err instanceof VersionConflictError) {
      useNotificationStore
        .getState()
        .warning(
          'This document changed on the relay while you were away — your local ' +
            'edits were not pushed to avoid overwriting them. Reopen the document to merge.',
        );
      return;
    }
    // The relay maps an over-quota upload to 507; its body carries the
    // "storage quota exceeded" wording, which rides through the blob-upload
    // error wrapper in `saveToHost` (the thrown Error has no `status`).
    if (status === 507 || /quota exceeded/i.test(message)) {
      useNotificationStore.getState().error(
        'Save failed: the workspace is out of storage. Free up space and try again — ' +
          'your local copy is kept and was not lost.',
        { category: 'permanent' },
      );
      return;
    }
    if (status === 403) {
      useNotificationStore.getState().error(
        'Save failed: you don’t have permission to edit this document. Your local copy is kept.',
        { category: 'permanent' },
      );
      return;
    }

    // Everything else is transient — network/timeout/abort, 5xx, 429, 401
    // (replays after token refresh), and a stalled or failed blob upload. Cache
    // + queue under the doc's home relay so the reconnect replay (which carries
    // the pinned blob refs) re-saves the edit instead of dropping it. This is
    // the path JP-127's ref-pinning was meant to protect: previously only a
    // literal "Not connected to host" reached it, so any other failure silently
    // lost the edit and a later reattach rolled the doc back.
    queueForReplay(
      message.includes('Not connected to host')
        ? 'Not connected'
        : `Transient save failure (${context})`,
    );
  });
}

/**
 * Persistence state.
 */
export interface PersistenceState {
  /** ID of the currently open document (null if untitled) */
  currentDocumentId: string | null;
  /** Name of the current document */
  currentDocumentName: string;
  /** Index of all saved documents (metadata only) */
  documents: Record<string, DocumentMetadata>;
  /** Whether the current document has unsaved changes */
  isDirty: boolean;
  /** Timestamp of last save (null if never saved) */
  lastSavedAt: number | null;
  /** Whether auto-save is enabled */
  autoSaveEnabled: boolean;
  /**
   * True when the last-opened document was a team doc that could not be
   * loaded because the collab connection wasn't available at startup.
   * UI uses this to show a "Reconnecting…" indicator and the collab
   * provider uses it to auto-reattach once authentication succeeds.
   */
  isAwaitingTeamLoad?: boolean;
  /**
   * True only when a relay doc was parked at startup *without* its content
   * hydrated into the page store (the doc wasn't cached locally). While
   * this is set, `saveDocument` must not run — serializing the blank/stale
   * page store would overwrite the relay doc or mint an orphan id (JP-106
   * defect D). Distinct from `isAwaitingTeamLoad`, which is also true in the
   * hydrated-from-cache reboot path where saving is perfectly safe. Cleared
   * once real content loads (`loadRemoteDocument` / `loadDocument`).
   */
  teamDocContentPending?: boolean;
}

/**
 * Persistence actions.
 */
export interface PersistenceActions {
  /** Create a new empty document */
  newDocument: (name?: string) => void;
  /** Save the current document */
  saveDocument: () => void;
  /** Save the current document with a new name */
  saveDocumentAs: (name: string) => void;
  /** Load a document by ID */
  loadDocument: (id: string) => boolean;
  /** Delete a document by ID (soft delete → moves it to the Trash). */
  deleteDocument: (id: string) => void;
  /** Permanently delete a document, bypassing the Trash and releasing blobs. */
  permanentlyDeleteDocument: (id: string) => void;
  /**
   * Adopt an existing document object into local storage as a personal
   * document — used by the Trash to restore a trashed/stranded doc (JP-291).
   * Strips relay-only fields so the restored copy is local-only.
   */
  adoptDocument: (doc: DiagramDocument) => void;
  /**
   * Demote the currently-open relay document to a local-only document in place
   * (JP-175). Used when the relay deletes the doc out from under an open editor:
   * the user keeps their work and keeps editing — saves now go local. Network-
   * free (no relay delete; the relay already removed it). No-op if there's no
   * open doc or it isn't a relay document.
   */
  demoteCurrentDocumentToLocal: () => void;
  /** Rename the current document */
  renameDocument: (name: string) => void;
  /** Export current document as JSON string */
  exportJSON: () => string;
  /** Import document from JSON string */
  importJSON: (json: string) => boolean;
  /** Mark the document as dirty (has unsaved changes) */
  markDirty: () => void;
  /** Set auto-save enabled/disabled */
  setAutoSave: (enabled: boolean) => void;
  /** Get all document metadata sorted by modified date */
  getDocumentList: () => DocumentMetadata[];
  /** Check if a document exists */
  documentExists: (id: string) => boolean;
  /** Transfer a personal document to relay documents */
  transferToTeam: (docId: string) => boolean;
  /** Transfer a relay document to personal documents */
  transferToPersonal: (docId: string) => boolean;
  /** Create a new relay document with the given name, awaiting the relay push */
  createRelayDocumentAs: (name: string) => Promise<{ ok: true; docId: string } | { ok: false; error: string }>;
  /** Rename any document by id (handles active/non-active, local/relay) */
  renameDocumentById: (docId: string, newName: string) => Promise<{ ok: true } | { ok: false; reason: 'not-found' | 'version-conflict' | 'network-error'; message?: string }>;
  /** Load a remote document (from host) directly into the editor */
  loadRemoteDocument: (doc: DiagramDocument) => void;
  /** Reset to initial state */
  reset: () => void;
}

/**
 * Initial persistence state.
 */
const initialState: PersistenceState = {
  currentDocumentId: null,
  currentDocumentName: 'Untitled Document',
  documents: {},
  isDirty: false,
  lastSavedAt: null,
  autoSaveEnabled: true,
};

/**
 * Save a document to localStorage.
 *
 * Also pushes a snapshot to the MCP local-document mirror (best-effort,
 * no-op outside Tauri or when the user has disabled MCP local access).
 * Skip relay documents — those flow through the host's team_documents
 * store directly and don't need to be mirrored.
 */
export function saveDocumentToStorage(doc: DiagramDocument): void {
  try {
    const key = `${STORAGE_KEYS.DOCUMENT_PREFIX}${doc.id}`;
    localStorage.setItem(key, JSON.stringify(doc));
  } catch (error) {
    console.error('Failed to save document to localStorage:', error);
    throw new Error('Failed to save document. Storage may be full.');
  }
}

/**
 * Load a document from localStorage.
 */
export function loadDocumentFromStorage(id: string): DiagramDocument | null {
  try {
    const key = `${STORAGE_KEYS.DOCUMENT_PREFIX}${id}`;
    const json = localStorage.getItem(key);
    if (!json) return null;
    return JSON.parse(json) as DiagramDocument;
  } catch (error) {
    console.error('Failed to load document from localStorage:', error);
    return null;
  }
}

/**
 * Read just the `pdfSettings` slice of a document from disk. Returns
 * `null` when the document is missing or has no settings persisted.
 * Used by the PDF export dialog to seed its form per-document rather
 * than from app-wide defaults.
 */
export function loadDocumentPdfSettings(id: string): import('../types/PDFExport').PDFSettings | null {
  const doc = loadDocumentFromStorage(id);
  return doc?.pdfSettings ?? null;
}

/**
 * Drop the `pdfSettings` field from the saved document. After this, the
 * PDF export dialog will reseed from app-level factory defaults the next
 * time it opens for this document. Returns `false` when the document
 * doesn't exist in storage yet (caller can no-op).
 *
 * Team docs are also handled: the cleared doc is pushed back to the host
 * so collaborators don't keep seeing the old settings.
 */
export function clearDocumentPdfSettings(id: string): boolean {
  const doc = loadDocumentFromStorage(id);
  if (!doc) return false;
  delete doc.pdfSettings;
  doc.modifiedAt = Date.now();
  saveDocumentToStorage(doc);

  pushRelaySaveOrQueue(doc, 'clear pdfSettings');
  return true;
}

/**
 * Persist a `pdfSettings` snapshot to the saved document. Does a
 * read-modify-write so it survives independently of the next full
 * document save. Returns `false` when the document doesn't exist in
 * storage yet (e.g. brand-new unsaved doc) so the caller can defer
 * until the first proper save.
 *
 * Team documents: the change is written to localStorage *and* pushed to
 * the host so it round-trips back to other collaborators on reload. We
 * mirror the same dual-write that `saveDocument` does for full doc
 * snapshots — see lines around the `save_team_document` invocation
 * there for the matching path. Push failures are logged but don't
 * surface to the caller; the localStorage write is the local source of
 * truth for the running session.
 */
export function saveDocumentPdfSettings(
  id: string,
  pdfSettings: import('../types/PDFExport').PDFSettings,
): boolean {
  const doc = loadDocumentFromStorage(id);
  if (!doc) return false;
  doc.pdfSettings = pdfSettings;
  doc.modifiedAt = Date.now();
  saveDocumentToStorage(doc);

  pushRelaySaveOrQueue(doc, 'save pdfSettings');
  return true;
}

/**
 * Delete a document from localStorage. Also drops it from the MCP mirror
 * so deleted docs don't keep being listed via MCP.
 */
export function deleteDocumentFromStorage(id: string): void {
  try {
    const key = `${STORAGE_KEYS.DOCUMENT_PREFIX}${id}`;
    localStorage.removeItem(key);
  } catch (error) {
    console.error('Failed to delete document from localStorage:', error);
  }
}

/**
 * Walk every page in a snapshot and verify shape/shapeOrder agreement.
 * Returns a list of issues (empty array means clean). This is the last
 * line of defense before a save: if a cross-page corruption ever bypassed
 * the historyStore guards, we'd rather refuse to write than overwrite a
 * good document on disk with corrupted state.
 */
function findPageIntegrityIssues(pages: Record<string, Page>): string[] {
  // Only flag the dangerous direction — shapeOrder pointing at a shape id
  // that doesn't exist. The reverse (shape present but not in shapeOrder)
  // is normal: group children are stored in `shapes` but tracked through
  // their parent group's `childIds`, never in the page-level shapeOrder.
  const issues: string[] = [];
  for (const [pageId, page] of Object.entries(pages)) {
    const shapeIds = new Set(Object.keys(page.shapes ?? {}));
    for (const id of page.shapeOrder ?? []) {
      if (!shapeIds.has(id)) {
        issues.push(`page ${pageId}: shapeOrder references missing shape "${id}"`);
      }
    }
  }
  return issues;
}

/**
 * Thrown by `createDocumentFromPageStore` when a corrupt in-memory page is
 * detected. Save callers catch this, surface a notification, and abort
 * rather than persist the corruption.
 */
export class DocumentIntegrityError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Document integrity check failed:\n${issues.join('\n')}`);
    this.name = 'DocumentIntegrityError';
  }
}

/**
 * Create a DiagramDocument from current page store state.
 *
 * Throws `DocumentIntegrityError` if any page's shapes/shapeOrder are
 * inconsistent — saving such a state would persist corruption.
 */
function createDocumentFromPageStore(
  id: string,
  name: string,
  existingDoc?: DiagramDocument
): DiagramDocument {
  const pageSnapshot = usePageStore.getState().getSnapshot();

  const issues = findPageIntegrityIssues(pageSnapshot.pages);
  if (issues.length > 0) {
    // eslint-disable-next-line no-console
    console.error('[persistenceStore] aborting save — page integrity check failed:', issues);
    throw new DocumentIntegrityError(issues);
  }
  const richTextContent = useRichTextStore.getState().getContent();
  const richTextPages = useRichTextPagesStore.getState().serialize();
  const references = useReferenceStore.getState().serialize();
  const fields = useFieldStore.getState().serialize();
  const whiteboardSnapshot = useWhiteboardStore.getState().getSnapshot();

  const doc: DiagramDocument = {
    id,
    name,
    pages: pageSnapshot.pages,
    pageOrder: pageSnapshot.pageOrder,
    activePageId: pageSnapshot.activePageId ?? pageSnapshot.pageOrder[0] ?? '',
    createdAt: existingDoc?.createdAt ?? Date.now(),
    modifiedAt: Date.now(),
    version: 1,
    richTextContent,
    richTextPages,
    references,
    fields,
    whiteboard: whiteboardSnapshot,
  };

  // Preserve PDF export settings — these are owned by the document, not
  // by the in-memory edit state. Without this, every save would erase the
  // user's per-document PDF preferences (margins, cover-page, etc.).
  if (existingDoc?.pdfSettings) {
    doc.pdfSettings = existingDoc.pdfSettings;
  }

  // Preserve team-related fields from existing document
  if (existingDoc) {
    if (existingDoc.isRelayDocument !== undefined) {
      doc.isRelayDocument = existingDoc.isRelayDocument;
    }
    if (existingDoc.ownerId !== undefined) {
      doc.ownerId = existingDoc.ownerId;
    }
    if (existingDoc.ownerName !== undefined) {
      doc.ownerName = existingDoc.ownerName;
    }
    if (existingDoc.lockedBy !== undefined) {
      doc.lockedBy = existingDoc.lockedBy;
    }
    if (existingDoc.lockedByName !== undefined) {
      doc.lockedByName = existingDoc.lockedByName;
    }
    if (existingDoc.lockedAt !== undefined) {
      doc.lockedAt = existingDoc.lockedAt;
    }
    if (existingDoc.sharedWith !== undefined) {
      doc.sharedWith = existingDoc.sharedWith;
    }
    if (existingDoc.lastModifiedBy !== undefined) {
      doc.lastModifiedBy = existingDoc.lastModifiedBy;
    }
    if (existingDoc.lastModifiedByName !== undefined) {
      doc.lastModifiedByName = existingDoc.lastModifiedByName;
    }
  }

  return doc;
}

/**
 * Load a DiagramDocument into the page store and rich text store.
 */
function loadDocumentToPageStore(doc: DiagramDocument): void {
  // Switching documents: drop the previous doc's FileShape thumbnail caches
  // (revoking minted object URLs) so this doc re-resolves its blob:// thumbnails
  // and never shows a stale image or a stale missing-blob overlay.
  resetFileThumbnailCaches();

  // Suppress autosave subscribers while we replay the document into the
  // live stores — these writes are a load, not a user edit, and would
  // otherwise schedule a spurious push back to the relay on next debounce.
  withAutoSaveSuppressed(() => {
    const snapshot: PageStoreSnapshot = {
      pages: doc.pages,
      pageOrder: doc.pageOrder,
      activePageId: doc.activePageId,
    };
    usePageStore.getState().loadSnapshot(snapshot);

    // Load rich text content (or reset if not present for backwards compatibility)
    useRichTextStore.getState().loadContent(doc.richTextContent);

    // Load rich text pages (or initialize with default if not present)
    if (doc.richTextPages) {
      useRichTextPagesStore.getState().loadPages(doc.richTextPages);
    } else {
      // Backwards compatibility: reset to default page
      useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null });
      useRichTextPagesStore.getState().initializeDefaultPage();
    }

    // Load reference library (JP-89) — clear when absent so a prior document's
    // references never bleed into one that has none (back-compat for pre-JP-89
    // documents). `loadReferences` defensively normalizes malformed input.
    if (doc.references) {
      useReferenceStore.getState().loadReferences(doc.references);
    } else {
      useReferenceStore.getState().clear();
    }

    // Load field library (Phase 3) — clear when absent so a prior document's
    // fields never bleed into one that has none (back-compat for pre-Phase-3
    // documents). `loadFields` defensively normalizes malformed input.
    if (doc.fields) {
      useFieldStore.getState().loadFields(doc.fields);
    } else {
      useFieldStore.getState().clear();
    }

    // Load whiteboard state (or initialize with defaults if not present)
    if (doc.whiteboard) {
      useWhiteboardStore.getState().loadSnapshot(doc.whiteboard);
    } else {
      useWhiteboardStore.getState().reset();
    }
  });
}

/**
 * Persistence store for document management.
 *
 * Usage:
 * ```typescript
 * const { saveDocument, loadDocument, isDirty } = usePersistenceStore();
 *
 * // Save current document
 * saveDocument();
 *
 * // Load a document
 * loadDocument(documentId);
 *
 * // Check for unsaved changes
 * if (isDirty) { ... }
 * ```
 */
export const usePersistenceStore = create<PersistenceState & PersistenceActions>()(
  persist(
    (set, get) => ({
      // State
      ...initialState,

      // Create a new empty document
      newDocument: (name?: string) => {
        const docName = name ?? 'Untitled Document';

        // These store resets are a programmatic reset, NOT user edits — suppress
        // autosave so their subscriptions (and any nodeView reaction to
        // `referenceStore.clear`, e.g. a still-mounted bibliography) can't
        // schedule a save during the null-id window and mint a phantom doc
        // (JP-89). Mirrors `loadDocumentToPageStore`.
        withAutoSaveSuppressed(() => {
          // Reset page store to empty
          usePageStore.getState().reset();
          usePageStore.getState().initializeDefault();

          // Sync the new empty page to documentStore (clears old shapes)
          usePageStore.getState().syncDocumentToCurrentPage();

          // Reset rich text store to empty
          useRichTextStore.getState().reset();

          // Reset rich text pages and initialize with default page
          useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null });
          useRichTextPagesStore.getState().initializeDefaultPage();

          // Reset the reference library (JP-89) for the new empty document
          useReferenceStore.getState().clear();

          // Clear selection and history
          useSessionStore.getState().clearSelection();
          useHistoryStore.getState().clear();

          // Clear active document in registry
          useDocumentRegistry.getState().setActiveDocument(null);

          set({
            currentDocumentId: null,
            currentDocumentName: docName,
            isDirty: false,
            lastSavedAt: null,
          });
        });
      },

      // Save the current document
      saveDocument: () => {
        const state = get();

        // Don't autosave while a relay doc was parked at startup *without*
        // its content hydrated (JP-106 defect D). The page store doesn't
        // hold this doc yet, so saving would overwrite the relay doc with a
        // blank snapshot or — if currentDocumentId is momentarily null —
        // mint a fresh nanoid and orphan the relay id (the FbJx-vs-kYev
        // divergence). NOTE: scoped to `teamDocContentPending`, not the
        // broader `isAwaitingTeamLoad`, which is also set in the
        // hydrated-from-cache reboot path where offline edits must save.
        if (state.teamDocContentPending) {
          return;
        }

        let docId = state.currentDocumentId;

        // If no ID, create a new one
        if (!docId) {
          docId = nanoid();
        }

        // Get existing document for createdAt timestamp and old blob references
        const existingDoc = docId ? loadDocumentFromStorage(docId) : undefined;
        const oldBlobRefs = new Set(existingDoc?.blobReferences ?? []);

        // Create document from current state. Throws DocumentIntegrityError if
        // any page is internally inconsistent — refuse the save in that case
        // so we don't overwrite a good on-disk document with corrupted state.
        let doc: DiagramDocument;
        try {
          doc = createDocumentFromPageStore(
            docId,
            state.currentDocumentName,
            existingDoc ?? undefined
          );
        } catch (err) {
          if (err instanceof DocumentIntegrityError) {
            useNotificationStore.getState().error(
              'Save aborted: page data failed an integrity check. Your previously saved version is unchanged. Please report this.',
              { category: 'permanent' },
            );
            return;
          }
          throw err;
        }

        // Extract blob references from rich text content and shapes
        const richTextBlobs = extractRichTextBlobIds(doc.richTextContent);
        const shapeBlobs = extractShapeBlobIds(doc.pages ?? {});
        doc.blobReferences = [...richTextBlobs, ...shapeBlobs];
        const newBlobRefs = new Set(doc.blobReferences);

        // Track blob reference changes and update usage counts
        // Decrement usage for removed blobs (was in old, not in new)
        for (const blobId of oldBlobRefs) {
          if (!newBlobRefs.has(blobId)) {
            blobStorage.decrementUsageCount(blobId).catch((error) => {
              console.error(`Failed to decrement usage count for blob ${blobId}:`, error);
            });
          }
        }

        // Save to localStorage
        saveDocumentToStorage(doc);

        // Update metadata index
        const metadata = getDocumentMetadata(doc);

        set((state) => ({
          currentDocumentId: docId,
          documents: {
            ...state.documents,
            [docId!]: metadata,
          },
          isDirty: false,
          lastSavedAt: Date.now(),
        }));

        // Register in document registry (for local documents)
        if (!doc.isRelayDocument) {
          useDocumentRegistry.getState().registerLocal(metadata);
          useDocumentRegistry.getState().setActiveDocument(docId);
        }

        // Save current document ID
        localStorage.setItem(STORAGE_KEYS.CURRENT_DOCUMENT, docId);

        // If relay document, push to the relay via REST — or cache + queue
        // for replay when offline so the edit isn't lost (JP-106).
        pushRelaySaveOrQueue(doc, 'saveDocument');
      },

      // Save with a new name
      saveDocumentAs: (name: string) => {
        const newId = nanoid();

        // Create document from current state (integrity-guarded — see saveDocument)
        let doc: DiagramDocument;
        try {
          doc = createDocumentFromPageStore(newId, name);
        } catch (err) {
          if (err instanceof DocumentIntegrityError) {
            useNotificationStore.getState().error(
              'Save aborted: page data failed an integrity check. Please report this.',
              { category: 'permanent' },
            );
            return;
          }
          throw err;
        }

        // Extract blob references from rich text content and shapes
        const richTextBlobs = extractRichTextBlobIds(doc.richTextContent);
        const shapeBlobs = extractShapeBlobIds(doc.pages ?? {});
        doc.blobReferences = [...richTextBlobs, ...shapeBlobs];

        // Save to localStorage
        saveDocumentToStorage(doc);

        // Update metadata index
        const metadata = getDocumentMetadata(doc);

        set((state) => ({
          currentDocumentId: newId,
          currentDocumentName: name,
          documents: {
            ...state.documents,
            [newId]: metadata,
          },
          isDirty: false,
          lastSavedAt: Date.now(),
        }));

        // Register in document registry
        useDocumentRegistry.getState().registerLocal(metadata);
        useDocumentRegistry.getState().setActiveDocument(newId);

        // Save current document ID
        localStorage.setItem(STORAGE_KEYS.CURRENT_DOCUMENT, newId);
      },

      // Load a document by ID
      loadDocument: (id: string): boolean => {
        // Commit any pending autosave under the *current* docId before we
        // flip currentDocumentId. Otherwise the debounced save would fire
        // later and write the new doc's content under the old doc's id —
        // losing the in-flight edit.
        flushAutoSaveNow();

        const doc = loadDocumentFromStorage(id);
        if (!doc) {
          console.warn(`Document ${id} not found`);
          return false;
        }

        // Load into page store
        loadDocumentToPageStore(doc);

        set({
          currentDocumentId: id,
          currentDocumentName: doc.name,
          isDirty: false,
          lastSavedAt: doc.modifiedAt,
          isAwaitingTeamLoad: false,
          teamDocContentPending: false,
        });

        // Register in document registry and set as active
        const metadata = getDocumentMetadata(doc);
        if (!doc.isRelayDocument) {
          useDocumentRegistry.getState().registerLocal(metadata);
        }
        useDocumentRegistry.getState().setActiveDocument(id);
        useDocumentRegistry.getState().setDocumentContent(id, doc);

        // Activate the local CRDT engine for relay documents (JP-108 step 3).
        // This brings up the Y.Doc + y-indexeddb engine even with no connection
        // (engine ≠ provider), so edits are CRDT ops from the first keystroke
        // and survive offline. Local documents are renderer-owned and never get
        // an engine — emitting JOIN_DOC for them produces a misleading server
        // log and (worse) opens a cross-client leak if a second client ever
        // joins the same phantom doc id (JP-64); `ensureCollabSessionForDoc`
        // guards that. No-op if already the active engine for this doc.
        if (doc.isRelayDocument) {
          void ensureCollabSessionForDoc(id);
        } else {
          // Opening a local doc means we've LEFT any relay doc — leave the
          // doc's collab session so its engine stops broadcasting and the
          // presence "collaborate" frame (gated on `isActive`) clears (JP-188).
          // Use `leaveDocument`, NOT `stopSession`: it stays signed in to the
          // relay (preserves the token), so reopening a relay doc reconnects
          // authenticated instead of dropping to offline/re-login (JP-190). A
          // relay→relay switch is handled by `switchDocument` above; this is the
          // relay→local exit. Durable state stays on disk (relay binary +
          // y-indexeddb), so reopening the relay doc re-hydrates.
          const collab = useCollaborationStore.getState();
          if (collab.isActive) collab.leaveDocument();
        }

        // Save current document ID
        localStorage.setItem(STORAGE_KEYS.CURRENT_DOCUMENT, id);

        return true;
      },

      // Delete a document by ID — soft delete: move it to the Trash so it's
      // recoverable (JP-292). Blobs are NOT released here; they stay referenced
      // via the trash mark-set until the entry is purged/emptied/expired
      // (JP-291). Hard removal is `permanentlyDeleteDocument`.
      deleteDocument: (id: string) => {
        const state = get();

        const doc = loadDocumentFromStorage(id);
        if (doc) {
          // Snapshot into the trash, then drop the active copy. (No blob
          // decrement — the trashed copy still references them.)
          useTrashStore.getState().trashLocal(doc);
        }

        // Drop the active localStorage copy + index entry. The trash keeps its
        // own copy under a separate key.
        deleteDocumentFromStorage(id);
        set((state) => {
          const newDocuments = { ...state.documents };
          delete newDocuments[id];
          return { documents: newDocuments };
        });
        useDocumentRegistry.getState().removeDocument(id);

        // If we deleted the current document, create a new one
        if (state.currentDocumentId === id) {
          get().newDocument();
        }
      },

      // Permanently delete a document, bypassing the Trash (JP-292). Releases
      // its blob references immediately. Use for "Delete permanently" and for
      // purging from the Trash.
      permanentlyDeleteDocument: (id: string) => {
        const state = get();

        // Load document to get blob references
        const doc = loadDocumentFromStorage(id);
        if (doc && doc.blobReferences) {
          // Decrement usage count for each referenced blob
          doc.blobReferences.forEach((blobId) => {
            blobStorage.decrementUsageCount(blobId).catch((error) => {
              console.error(`Failed to decrement usage count for blob ${blobId}:`, error);
            });
          });
        }

        // Delete from localStorage
        deleteDocumentFromStorage(id);

        // Remove from index
        set((state) => {
          const newDocuments = { ...state.documents };
          delete newDocuments[id];
          return { documents: newDocuments };
        });

        // Remove from document registry
        useDocumentRegistry.getState().removeDocument(id);

        // If we deleted the current document, create a new one
        if (state.currentDocumentId === id) {
          get().newDocument();
        }
      },

      adoptDocument: (doc: DiagramDocument) => {
        // Restore into the personal/local space: drop relay-only fields so the
        // copy is local-only (a stranded relay doc can't go back to a relay
        // that deleted it — see JP-175). Blob bytes stay in IndexedDB and are
        // already kept alive via the trash mark-set, so refcounts are untouched.
        const {
          isRelayDocument: _isRelay,
          serverVersion: _sv,
          lockedBy: _lb,
          lockedByName: _lbn,
          lockedAt: _la,
          ...rest
        } = doc;
        const localDoc: DiagramDocument = { ...rest, isRelayDocument: false };

        saveDocumentToStorage(localDoc);
        const metadata = getDocumentMetadata(localDoc);

        set((state) => ({
          documents: { ...state.documents, [localDoc.id]: metadata },
        }));

        useDocumentRegistry.getState().registerLocal(metadata);
      },

      demoteCurrentDocumentToLocal: () => {
        const docId = get().currentDocumentId;
        if (!docId) return;

        // The open relay doc is mirrored to localStorage by loadRemoteDocument,
        // so it's loadable here. Flip it local in place (mirrors transferToPersonal's
        // field clear, minus the network delete — the relay already removed it).
        const doc = loadDocumentFromStorage(docId);
        if (!doc || !doc.isRelayDocument) return;

        doc.isRelayDocument = false;
        delete doc.ownerId;
        delete doc.ownerName;
        delete doc.lockedBy;
        delete doc.lockedByName;
        delete doc.lockedAt;
        delete doc.sharedWith;
        delete doc.lastModifiedBy;
        delete doc.lastModifiedByName;
        delete doc.serverVersion;
        doc.modifiedAt = Date.now();

        saveDocumentToStorage(doc);
        const metadata = getDocumentMetadata(doc);
        set((state) => ({ documents: { ...state.documents, [docId]: metadata } }));

        const registry = useDocumentRegistry.getState();
        registry.registerLocal(metadata);
        registry.setActiveDocument(docId);
      },

      // Rename the current document
      renameDocument: (name: string) => {
        const state = get();
        const docId = state.currentDocumentId;
        const isSaved = !!(docId && state.documents[docId]);
        const isCollab = !!docId && isCollabContentDoc(docId);

        set({ currentDocumentName: name, isDirty: true });

        // If document is saved, update metadata
        if (isSaved) {
          const existingMeta = state.documents[docId!]!;
          const updatedMeta: DocumentMetadata = {
            ...existingMeta,
            name,
          };
          set({
            documents: {
              ...state.documents,
              [docId!]: updatedMeta,
            },
          });

          // Also update the document registry for reactivity
          useDocumentRegistry.getState().updateRecord(docId!, { name });
        }

        if (isCollab) {
          // CRDT-native rename: when this is the active collab content doc, push
          // the name through the Y.Doc metadata so it reaches the relay + peers.
          // The REST save path that would otherwise carry the name is suppressed
          // for collab docs (isCollabContentDoc), so without this the rename never
          // leaves the device.
          useCollaborationStore.getState().syncDocumentName(name);
        } else if (!isSaved) {
          // Fresh untitled / not-yet-saved local doc: it has no metadata-map
          // entry, so the rename would otherwise live only in
          // `currentDocumentName` and revert (desync) on the next save/reload —
          // JP-324 #9. Persist now so the rename is durable and the doc gains a
          // stable id + registry entry. `saveDocument` mints the id, writes the
          // metadata map, and registers it; it self-guards parked relay docs
          // (teamDocContentPending) and page-integrity failures.
          get().saveDocument();
        }
      },

      // Export current document as JSON
      exportJSON: (): string => {
        const state = get();
        const docId = state.currentDocumentId ?? nanoid();

        let doc: DiagramDocument;
        try {
          doc = createDocumentFromPageStore(docId, state.currentDocumentName);
        } catch (err) {
          if (err instanceof DocumentIntegrityError) {
            useNotificationStore.getState().error(
              'Export aborted: page data failed an integrity check.',
              { category: 'permanent' },
            );
            throw err;
          }
          throw err;
        }

        // Extract blob references from rich text content and shapes
        const richTextBlobs = extractRichTextBlobIds(doc.richTextContent);
        const shapeBlobs = extractShapeBlobIds(doc.pages ?? {});
        doc.blobReferences = [...richTextBlobs, ...shapeBlobs];

        return JSON.stringify(doc, null, 2);
      },

      // Import document from JSON
      importJSON: (json: string): boolean => {
        try {
          // Validate document structure before importing
          const validation = validateDocumentJSON(json);

          if (!validation.valid) {
            console.error('Invalid document format:', validation.errors);
            // Try to show user-facing notification
            import('./notificationStore').then(({ useNotificationStore }) => {
              useNotificationStore.getState().error(
                `Import failed: ${validation.errors[0] ?? 'Invalid document format'}`
              );
            });
            return false;
          }

          // Log any warnings
          if (validation.warnings.length > 0) {
            console.warn('Document import warnings:', validation.warnings);
          }

          // Use validated and normalized document
          const doc = validation.document!;

          // Generate new ID to avoid conflicts
          const newId = nanoid();
          doc.id = newId;
          doc.modifiedAt = Date.now();

          // Increment usage counts for referenced blobs
          if (doc.blobReferences) {
            doc.blobReferences.forEach((blobId) => {
              blobStorage.incrementUsageCount(blobId).catch((error) => {
                console.error(`Failed to increment usage count for blob ${blobId}:`, error);
              });
            });
          }

          // Save to localStorage
          saveDocumentToStorage(doc);

          // Load into page store
          loadDocumentToPageStore(doc);

          // Update metadata index
          const metadata = getDocumentMetadata(doc);

          set((state) => ({
            currentDocumentId: newId,
            currentDocumentName: doc.name,
            documents: {
              ...state.documents,
              [newId]: metadata,
            },
            isDirty: false,
            lastSavedAt: Date.now(),
          }));

          // Register in document registry
          useDocumentRegistry.getState().registerLocal(metadata);
          useDocumentRegistry.getState().setActiveDocument(newId);
          useDocumentRegistry.getState().setDocumentContent(newId, doc);

          // Save current document ID
          localStorage.setItem(STORAGE_KEYS.CURRENT_DOCUMENT, newId);

          // Show success notification
          import('./notificationStore').then(({ useNotificationStore }) => {
            useNotificationStore.getState().success(`Imported "${doc.name}"`);
          });

          return true;
        } catch (error) {
          console.error('Failed to import document:', error);
          // Show error notification
          import('./notificationStore').then(({ useNotificationStore }) => {
            const message = error instanceof Error ? error.message : 'Unknown error';
            useNotificationStore.getState().error(`Import failed: ${message}`);
          });
          return false;
        }
      },

      // Mark document as dirty
      markDirty: () => {
        set({ isDirty: true });
      },

      // Set auto-save
      setAutoSave: (enabled: boolean) => {
        set({ autoSaveEnabled: enabled });
      },

      // Get sorted document list
      getDocumentList: (): DocumentMetadata[] => {
        const docs = Object.values(get().documents);
        return docs.sort((a, b) => b.modifiedAt - a.modifiedAt);
      },

      // Check if document exists
      documentExists: (id: string): boolean => {
        return !!get().documents[id];
      },

      // Transfer a personal document to relay documents
      transferToTeam: (docId: string): boolean => {
        // Load the document
        const doc = loadDocumentFromStorage(docId);
        if (!doc) {
          console.warn(`Document ${docId} not found for transfer`);
          return false;
        }

        // Already a relay document
        if (doc.isRelayDocument) {
          console.warn(`Document ${docId} is already a relay document`);
          return false;
        }

        // Get current user for ownership
        const currentUser = useUserStore.getState().currentUser;

        // Update team fields
        doc.isRelayDocument = true;
        if (currentUser?.id) {
          doc.ownerId = currentUser.id;
          doc.lastModifiedBy = currentUser.id;
        }
        if (currentUser?.displayName) {
          doc.ownerName = currentUser.displayName;
          doc.lastModifiedByName = currentUser.displayName;
        }
        doc.modifiedAt = Date.now();

        // Save back to localStorage
        saveDocumentToStorage(doc);

        // Update metadata index
        const metadata = getDocumentMetadata(doc);
        set((state) => ({
          documents: {
            ...state.documents,
            [docId]: metadata,
          },
        }));

        // Push to the relay via REST — or cache + queue for replay when
        // offline so the edit isn't lost (JP-106).
        pushRelaySaveOrQueue(doc, 'createRelayDocument');

        return true;
      },

      // Transfer a relay document to personal documents
      transferToPersonal: (docId: string): boolean => {
        // Load the document
        const doc = loadDocumentFromStorage(docId);
        if (!doc) {
          console.warn(`Document ${docId} not found for transfer`);
          return false;
        }

        // Not a relay document
        if (!doc.isRelayDocument) {
          console.warn(`Document ${docId} is already a personal document`);
          return false;
        }

        // If connected to a relay, delete from the relay first.
        const relayDocs = useRelayDocumentStore.getState();
        if (relayDocs.authenticated && relayDocs.isRelayDocument(docId)) {
          relayDocs.deleteFromHost(docId).catch((error) => {
            console.error('Failed to delete relay document from server:', error);
          });
        }

        // Clear team-specific fields
        doc.isRelayDocument = false;
        delete doc.ownerId;
        delete doc.ownerName;
        delete doc.lockedBy;
        delete doc.lockedByName;
        delete doc.lockedAt;
        delete doc.sharedWith;
        delete doc.lastModifiedBy;
        delete doc.lastModifiedByName;
        doc.modifiedAt = Date.now();

        // Save back to localStorage
        saveDocumentToStorage(doc);

        // Update metadata index
        const metadata = getDocumentMetadata(doc);
        set((state) => ({
          documents: {
            ...state.documents,
            [docId]: metadata,
          },
        }));

        return true;
      },

      // Create a new relay document with the given name. Wraps saveDocumentAs
      // and then marks the new doc as a relay doc + pushes it to the relay.
      // Awaits the relay push so callers can surface success/failure in the UI.
      createRelayDocumentAs: async (name: string) => {
        // Save locally first via the existing path (sets currentDocumentId).
        get().saveDocumentAs(name);

        const newId = get().currentDocumentId;
        if (!newId) {
          return { ok: false, error: 'Failed to create local document' };
        }

        const doc = loadDocumentFromStorage(newId);
        if (!doc) {
          return { ok: false, error: 'Local document went missing after save' };
        }

        // Mark as relay doc (mirrors transferToTeam's field set).
        const currentUser = useUserStore.getState().currentUser;
        doc.isRelayDocument = true;
        if (currentUser?.id) {
          doc.ownerId = currentUser.id;
          doc.lastModifiedBy = currentUser.id;
        }
        if (currentUser?.displayName) {
          doc.ownerName = currentUser.displayName;
          doc.lastModifiedByName = currentUser.displayName;
        }
        doc.modifiedAt = Date.now();

        saveDocumentToStorage(doc);
        const metadata = getDocumentMetadata(doc);
        set((state) => ({
          documents: { ...state.documents, [newId]: metadata },
        }));

        if (!isRelayAuthenticated()) {
          return { ok: false, error: 'Not connected to a relay' };
        }

        const teamDocStore = useRelayDocumentStore.getState();
        if (!teamDocStore.authenticated) {
          return { ok: false, error: 'Not authenticated to relay' };
        }

        try {
          await teamDocStore.saveToHost(doc);

          // Make the just-created relay doc the live collab target. Without this
          // the session stays pinned to the previously open doc: `collabDocId`
          // diverges from `currentDocumentId`, `collabMode` goes false, and prose
          // silently falls back to the non-collab editor (canvas masks it because
          // its sync ignores the id match). `saveToHost` doesn't change the
          // registry record type, so the doc is still registered `local` from
          // `saveDocumentAs` — re-register it as remote via the list, then switch,
          // mirroring DocumentBrowser's proven promote path. [JP-174]
          useDocumentRegistry.getState().removeDocument(newId);
          await teamDocStore.fetchDocumentList();
          await ensureCollabSessionForDoc(newId);

          return { ok: true, docId: newId };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown relay error';
          return { ok: false, error: message };
        }
      },

      // Rename a document by id (any document, active or not, local or relay).
      // For relay docs, surfaces VersionConflictError as a typed result so the
      // UI can show the "modified by someone else" toast.
      renameDocumentById: async (docId: string, newName: string) => {
        // Active doc takes the simpler path that also updates pageStore-driven
        // titles via the existing renameDocument action.
        if (docId === get().currentDocumentId) {
          get().renameDocument(newName);
          return { ok: true };
        }

        const doc = loadDocumentFromStorage(docId);
        if (!doc) {
          return { ok: false, reason: 'not-found' };
        }

        doc.name = newName;
        doc.modifiedAt = Date.now();
        saveDocumentToStorage(doc);

        // Update metadata + registry so the list reflects the rename immediately.
        const metadata = getDocumentMetadata(doc);
        set((state) => ({
          documents: { ...state.documents, [docId]: metadata },
        }));
        useDocumentRegistry.getState().updateRecord(docId, { name: newName });

        if (doc.isRelayDocument && isRelayAuthenticated()) {
          const teamDocStore = useRelayDocumentStore.getState();
          if (teamDocStore.authenticated) {
            try {
              await teamDocStore.saveToHost(doc, doc.serverVersion);
            } catch (err) {
              if (err instanceof VersionConflictError) {
                return { ok: false, reason: 'version-conflict' };
              }
              const message = err instanceof Error ? err.message : 'Failed to save to relay';
              return { ok: false, reason: 'network-error', message };
            }
          }
        }

        return { ok: true };
      },

      // Load a remote document (from host) directly into the editor
      loadRemoteDocument: (doc: DiagramDocument) => {
        // Same rationale as loadDocument: flush before switching so we
        // don't lose the current doc's pending edit.
        flushAutoSaveNow();

        // Ensure relay document flag is set for documents loaded from host
        const docWithTeamFlag = {
          ...doc,
          isRelayDocument: true,
        };

        // Load into page store
        loadDocumentToPageStore(docWithTeamFlag);

        // Also save to localStorage so it's cached locally
        saveDocumentToStorage(docWithTeamFlag);

        // Update metadata index
        const metadata = getDocumentMetadata(docWithTeamFlag);

        set((state) => ({
          currentDocumentId: docWithTeamFlag.id,
          currentDocumentName: docWithTeamFlag.name,
          documents: {
            ...state.documents,
            [docWithTeamFlag.id]: metadata,
          },
          isDirty: false,
          lastSavedAt: docWithTeamFlag.modifiedAt,
          isAwaitingTeamLoad: false,
          teamDocContentPending: false,
        }));

        // Register in document registry
        // Note: For remote documents, the registry entry should already exist
        // from fetchDocumentList - we just set it as active and cache content
        const registry = useDocumentRegistry.getState();
        if (!registry.hasDocument(docWithTeamFlag.id)) {
          // If not registered yet, register as local (cached copy)
          registry.registerLocal(metadata);
        }
        registry.setActiveDocument(docWithTeamFlag.id);
        registry.setDocumentContent(docWithTeamFlag.id, docWithTeamFlag);

        // Activate / switch the local CRDT engine to this relay document
        // (JP-108 step 3). No-op if it's already the active engine's doc — which
        // is the case on the on-connect reattach path (loading the doc that's
        // already the session target), so this won't tear down the provider
        // whose callback is driving the reattach.
        void ensureCollabSessionForDoc(docWithTeamFlag.id);

        // Save current document ID
        localStorage.setItem(STORAGE_KEYS.CURRENT_DOCUMENT, docWithTeamFlag.id);
      },

      // Reset to initial state
      reset: () => {
        set(initialState);
      },
    }),
    {
      name: STORAGE_KEYS.DOCUMENT_INDEX,
      version: 1,
      partialize: (state) => ({
        // Only persist the document index and settings, not current document state
        documents: state.documents,
        autoSaveEnabled: state.autoSaveEnabled,
      }),
    }
  )
);

/**
 * Initialize persistence on app startup.
 * Loads the last opened document or creates a new one.
 * Also migrates existing documents to the document registry.
 */
export function initializePersistence(): void {
  const store = usePersistenceStore.getState();
  const registry = useDocumentRegistry.getState();

  // Migrate existing documents to registry (only local documents)
  const existingDocs = store.documents;
  for (const [id, metadata] of Object.entries(existingDocs)) {
    if (!registry.hasDocument(id) && !metadata.isRelayDocument) {
      registry.registerLocal(metadata);
    }
  }

  // Try to load the last opened document
  const lastDocId = localStorage.getItem(STORAGE_KEYS.CURRENT_DOCUMENT);

  if (lastDocId) {
    // If the last doc is a relay document, don't fall back to a fresh local
    // doc when it can't be loaded (server may not be up yet). Instead, park
    // the selection and let the collab provider reattach on auth.
    const metadata = store.documents[lastDocId];
    const isTeamMetadata = metadata?.isRelayDocument === true;
    const isTeamRegistryEntry = registry.entries[lastDocId]?.record.type === 'remote';

    if (store.documentExists(lastDocId)) {
      const success = store.loadDocument(lastDocId);
      if (success) {
        if (isTeamMetadata || isTeamRegistryEntry) {
          // Content WAS hydrated from local cache — keep the reattach hook
          // engaged for fresh server data, but saving is safe (offline edits
          // after reboot must persist), so content is not "pending".
          usePersistenceStore.setState({
            isAwaitingTeamLoad: true,
            teamDocContentPending: false,
          });
        }
        return;
      }
    }

    if (isTeamMetadata || isTeamRegistryEntry) {
      const name = metadata?.name ?? registry.entries[lastDocId]?.record.name ?? 'Relay Document';
      // Parked WITHOUT content (doc wasn't cached locally). Block saves until
      // real content arrives so we don't blank the relay doc (defect D).
      usePersistenceStore.setState({
        currentDocumentId: lastDocId,
        currentDocumentName: name,
        isDirty: false,
        lastSavedAt: null,
        isAwaitingTeamLoad: true,
        teamDocContentPending: true,
      });
      // Bring up the local CRDT engine for the parked relay doc (JP-108 step 3).
      // If this device has persisted Y.Doc state in y-indexeddb (synced before,
      // but the localStorage cache was lost), the engine adopts it — recovering
      // offline content even without a connection. No-op without persisted
      // state until the provider attaches on connect.
      void ensureCollabSessionForDoc(lastDocId);
      return;
    }
  }

  // No last document or failed to load - create new document
  store.newDocument();
}

/**
 * Apply a document name received over the collaboration channel (a remote
 * rename via the Y.Doc `metadata` map) to local state — WITHOUT writing back to
 * the relay or the Y.Doc, which would loop. Updates the active doc's display
 * name, the persisted document index, and the registry record. The cached doc
 * file is refreshed from the relay on the next full load. [CRDT-native rename]
 */
export function applyRemoteDocumentName(docId: string, name: string): void {
  if (!docId || typeof name !== 'string' || name.length === 0) return;
  const s = usePersistenceStore.getState();
  const isActive = s.currentDocumentId === docId;
  // Idempotent: skip if nothing would change (avoids churn from echoed updates).
  if (s.documents[docId]?.name === name && (!isActive || s.currentDocumentName === name)) {
    return;
  }
  usePersistenceStore.setState((prev) => {
    const meta = prev.documents[docId];
    return {
      ...(prev.currentDocumentId === docId ? { currentDocumentName: name } : {}),
      documents: meta ? { ...prev.documents, [docId]: { ...meta, name } } : prev.documents,
    };
  });
  useDocumentRegistry.getState().updateRecord(docId, { name });
}

/**
 * Attempt to reload the relay document the user had open at startup, after
 * the collab connection has authenticated. Called from collaborationStore's
 * onAuthenticated hook. Safe to call repeatedly; no-op if not awaiting.
 */
export async function reattachAwaitingTeamDocument(): Promise<void> {
  const state = usePersistenceStore.getState();
  if (!state.isAwaitingTeamLoad || !state.currentDocumentId) return;
  const docId = state.currentDocumentId;
  const hydrated = state.teamDocContentPending !== true;

  // If the locally-loaded copy has unsynced offline edits queued for replay,
  // do NOT overwrite the editor with the relay/server copy (JP-106): that
  // copy predates the offline edits, so loadRemoteDocument would clobber the
  // page store *and* localStorage and the edits would flicker out and revert.
  // Keep the local edits — already hydrated and queued — and let the sync
  // queue push them to the relay. Just disengage the reattach hook.
  if (hydrated && getSyncStateManager().hasPendingChanges(docId)) {
    usePersistenceStore.setState({ isAwaitingTeamLoad: false });
    return;
  }

  try {
    const doc = await useRelayDocumentStore.getState().loadRelayDocument(docId);

    // JP-127: a save can fail or be interrupted (a stalled upload, a dropped
    // non-"Not connected" error) without ever reaching the durable sync queue,
    // so `hasPendingChanges` was false above. But the locally-stored copy is
    // still *newer* than the relay's and holds the unsynced edit (e.g. a
    // just-added file). Overwriting it with the older relay copy is exactly the
    // rollback/data-loss the user hit. When local is newer, keep it and queue a
    // replay (carrying pinned blob refs) instead of clobbering.
    if (hydrated) {
      const local = loadDocumentFromStorage(docId);
      if (local?.isRelayDocument && local.modifiedAt > doc.modifiedAt) {
        const connected = useConnectionStore.getState().host?.address;
        const home = resolveHomeRelayId(docId) ?? connected ?? 'unknown';
        const pinned: DiagramDocument = {
          ...local,
          blobReferences: collectBlobReferences(local),
        };
        void RelayDocumentCache.put(pinned, home).catch((e) =>
          console.error('[persistence] Failed to re-cache newer local copy:', e),
        );
        // JP-108: for a collab-session doc the relay owns content — don't queue
        // an LWW replay (it would clobber the CRDT merge and bump serverVersion,
        // stranding the relay's binary Y.Doc). Keep the cached local copy; the
        // CRDT sync handshake reconciles. (Non-collab docs keep the JP-127 net.)
        if (!isCollabContentDoc(docId)) {
          getSyncStateManager().queueSave(pinned, home);
          // Push promptly rather than waiting for the next reconnect; the
          // host-queue processor is guarded against concurrent runs.
          if (home === connected) {
            void getSyncStateManager().processQueueForHost(home).catch(() => {});
          }
          console.warn(
            `[persistence] Local copy of ${docId} is newer than the relay copy ` +
              '(unsynced edit) — keeping it and queuing a replay instead of ' +
              'overwriting with the older relay copy (JP-127).',
          );
        }
        usePersistenceStore.setState({ isAwaitingTeamLoad: false });
        return;
      }
    }

    usePersistenceStore.getState().loadRemoteDocument(doc);
  } catch (error) {
    console.warn('[persistence] Failed to reattach relay document on auth:', error);
  }
}

/**
 * On relay (re)connect, push the open relay doc if it has unsynced in-session
 * edits — so a save fires on connect, not only on the next edit (JP-106
 * follow-up). Version-checked against the known `serverVersion` so a
 * concurrent server edit surfaces a conflict toast instead of being silently
 * clobbered. Docs with edits already in the durable sync queue are left to
 * the queue's reconnect replay (the single writer for those), and a clean
 * doc is a no-op. Called from collaborationStore's onAuthenticated hook.
 */
/**
 * On reconnect, re-push the active collab doc's blob bytes (JP-237). The collab
 * branch of `pushRelaySaveOrQueue` skips blob uploads while offline, so a file
 * added offline never reached the relay; this re-runs the (server-deduped) upload
 * once authenticated so it lands without needing a further edit. No-op for
 * non-collab docs (their bytes ride the REST save) or when still offline.
 */
export async function uploadCollabBlobsOnConnect(): Promise<void> {
  const ps = usePersistenceStore.getState();
  const docId = ps.currentDocumentId;
  if (!docId || !isCollabContentDoc(docId) || !isRelayAuthenticated()) return;

  const existing = loadDocumentFromStorage(docId);
  if (!existing?.isRelayDocument) return;

  try {
    await useRelayDocumentStore.getState().uploadCollabBlobs(existing);
  } catch (err) {
    console.warn('[persistenceStore] on-connect collab blob upload failed:', err);
  }
}

export async function syncCurrentDocToRelayOnConnect(): Promise<void> {
  const ps = usePersistenceStore.getState();
  const docId = ps.currentDocumentId;
  if (!docId || ps.teamDocContentPending) return;

  // JP-108: a doc in an active collab session is relay-owned — the WS sync
  // handshake reconciles its content on reconnect. A REST push here would
  // clobber the merge and bump serverVersion (stranding the binary Y.Doc).
  if (isCollabContentDoc(docId)) return;

  // The durable queue owns docs with queued offline edits — it auto-replays
  // on reconnect, so don't double-write them here (a second unversioned write
  // could clobber a freshly-pushed copy).
  if (getSyncStateManager().hasPendingChanges(docId)) return;
  if (!ps.isDirty) return;

  const existing = loadDocumentFromStorage(docId);
  if (!existing?.isRelayDocument) return;

  // Only push the current doc to the relay we just connected to if that relay
  // is the doc's home (JP-117). If it belongs elsewhere, leave it to the
  // durable queue, which is tagged with — and only replays under — its home
  // relay; pushing here would write it to the wrong relay.
  const home = resolveHomeRelayId(docId);
  const connected = useConnectionStore.getState().host?.address;
  if (connected !== undefined && home !== undefined && home !== connected) return;

  const relayStore = useRelayDocumentStore.getState();
  if (!relayStore.authenticated) return;

  // Serialize the freshest in-memory state, carrying the known server version
  // for the conflict check.
  let doc: DiagramDocument;
  try {
    doc = createDocumentFromPageStore(docId, ps.currentDocumentName, existing);
  } catch {
    return; // integrity guard — never push a corrupt snapshot
  }

  try {
    await relayStore.saveToHost(doc, existing.serverVersion);
    saveDocumentToStorage(doc);
    usePersistenceStore.setState({ isDirty: false, lastSavedAt: Date.now() });
  } catch (err) {
    if (err instanceof VersionConflictError) {
      useNotificationStore
        .getState()
        .warning(
          'This document changed on the relay while you were away — your local ' +
            'edits were not pushed to avoid overwriting them. Reopen the document to merge.',
        );
      return;
    }
    // Transient failure — don't drop the edit (JP-127). Cache + queue under the
    // doc's home relay (pinning refs) so it replays instead of being lost; the
    // doc also stays `isDirty` so it's retried on the next reconnect.
    const homeRelay = home ?? connected ?? 'unknown';
    const pinned: DiagramDocument = { ...doc, blobReferences: collectBlobReferences(doc) };
    void RelayDocumentCache.put(pinned, homeRelay).catch(() => {});
    getSyncStateManager().queueSave(pinned, homeRelay);
    console.warn('[persistence] on-connect relay sync failed; queued for replay:', err);
  }
}

/**
 * Download the current document as a JSON file.
 */
export function downloadDocument(filename?: string): void {
  const store = usePersistenceStore.getState();
  const json = store.exportJSON();
  const name = filename ?? `${store.currentDocumentName}.json`;

  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Upload and import a document from a JSON file.
 * Returns a promise that resolves to true if successful.
 */
export function uploadDocument(): Promise<boolean> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';

    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) {
        resolve(false);
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const json = reader.result as string;
        const success = usePersistenceStore.getState().importJSON(json);
        resolve(success);
      };
      reader.onerror = () => {
        console.error('Failed to read file');
        resolve(false);
      };
      reader.readAsText(file);
    };

    input.click();
  });
}
