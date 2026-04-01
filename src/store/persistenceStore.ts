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
import { useRichTextStore } from './richTextStore';
import { useRichTextPagesStore } from './richTextPagesStore';
import { useUserStore } from './userStore';
import { useTeamStore } from './teamStore';
import { useTeamDocumentStore } from './teamDocumentStore';
import { useSessionStore } from './sessionStore';
import { useHistoryStore } from './historyStore';
import { useDocumentRegistry } from './documentRegistry';
import { useCollaborationStore } from '../collaboration';
import { blobStorage } from '../storage/BlobStorage';
import { isTauri } from '../tauri/commands';

/**
 * Auto-save debounce time in milliseconds.
 */
export const AUTO_SAVE_DEBOUNCE = 2000;

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
  /** Delete a document by ID */
  deleteDocument: (id: string) => void;
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
  /** Transfer a personal document to team documents */
  transferToTeam: (docId: string) => boolean;
  /** Transfer a team document to personal documents */
  transferToPersonal: (docId: string) => boolean;
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
 * Delete a document from localStorage.
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
 * Extract blob IDs from Tiptap rich text content.
 * Looks for blob:// URLs in image nodes.
 *
 * @param content - Tiptap JSON content
 * @returns Array of blob IDs
 */
function extractBlobIds(richTextContent: any): string[] {
  const blobIds: string[] = [];

  function traverse(node: any) {
    if (!node) return;

    // Check if this is an image node with blob:// URL
    if (node.type === 'image' && node.attrs?.src) {
      const src = node.attrs.src as string;
      if (src.startsWith('blob://')) {
        const blobId = src.replace('blob://', '');
        blobIds.push(blobId);
      }
    }

    // Recursively traverse children
    if (node.content && Array.isArray(node.content)) {
      node.content.forEach((child: any) => traverse(child));
    }
  }

  // RichTextContent has structure { content: JSONContent, version: number }
  // JSONContent is the actual Tiptap document with { type: "doc", content: [...] }
  const tiptapContent = richTextContent?.content;
  if (tiptapContent) {
    traverse(tiptapContent);
  }

  return blobIds;
}

/**
 * Extract blob IDs from shape data.
 * Scans FileShape blobRef fields across all pages.
 */
function extractShapeBlobIds(pages: Record<string, any>): string[] {
  const blobIds: string[] = [];
  for (const pageId in pages) {
    if (!Object.prototype.hasOwnProperty.call(pages, pageId)) continue;
    const page = pages[pageId];
    const shapes = page?.shapes;
    if (!shapes || typeof shapes !== 'object') continue;
    for (const shapeId in shapes) {
      if (!Object.prototype.hasOwnProperty.call(shapes, shapeId)) continue;
      const shape = shapes[shapeId];
      if (shape?.type === 'file' && shape.blobRef) {
        blobIds.push(shape.blobRef);
      }
    }
  }
  return blobIds;
}

/**
 * Create a DiagramDocument from current page store state.
 */
function createDocumentFromPageStore(
  id: string,
  name: string,
  existingDoc?: DiagramDocument
): DiagramDocument {
  const pageSnapshot = usePageStore.getState().getSnapshot();
  const richTextContent = useRichTextStore.getState().getContent();
  const richTextPages = useRichTextPagesStore.getState().serialize();

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
  };

  // Preserve team-related fields from existing document
  if (existingDoc) {
    if (existingDoc.isTeamDocument !== undefined) {
      doc.isTeamDocument = existingDoc.isTeamDocument;
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
      },

      // Save the current document
      saveDocument: () => {
        const state = get();
        let docId = state.currentDocumentId;

        // If no ID, create a new one
        if (!docId) {
          docId = nanoid();
        }

        // Get existing document for createdAt timestamp and old blob references
        const existingDoc = docId ? loadDocumentFromStorage(docId) : undefined;
        const oldBlobRefs = new Set(existingDoc?.blobReferences ?? []);

        // Create document from current state
        const doc = createDocumentFromPageStore(
          docId,
          state.currentDocumentName,
          existingDoc ?? undefined
        );

        // Extract blob references from rich text content and shapes
        const richTextBlobs = doc.richTextContent ? extractBlobIds(doc.richTextContent) : [];
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
        if (!doc.isTeamDocument) {
          useDocumentRegistry.getState().registerLocal(metadata);
          useDocumentRegistry.getState().setActiveDocument(docId);
        }

        // Save current document ID
        localStorage.setItem(STORAGE_KEYS.CURRENT_DOCUMENT, docId);

        // If team document, also save to host
        if (doc.isTeamDocument) {
          const serverMode = useTeamStore.getState().serverMode;

          if (serverMode === 'host' && isTauri()) {
            // Host mode: save directly to Rust DocumentStore
            import('@tauri-apps/api/core').then(({ invoke }) => {
              invoke('save_team_document', { document: doc })
                .then(() => {
                  console.log('[persistenceStore] Synced team document to host:', doc.id);
                })
                .catch((error) => {
                  console.error('[persistenceStore] Failed to sync team document to host:', error);
                });
            });
          } else if (serverMode === 'client') {
            // Client mode: save via WebSocket
            const teamDocStore = useTeamDocumentStore.getState();
            if (teamDocStore.authenticated) {
              teamDocStore.saveToHost(doc).catch((error) => {
                console.error('[persistenceStore] Failed to sync team document to host:', error);
              });
            }
          }
        }
      },

      // Save with a new name
      saveDocumentAs: (name: string) => {
        const newId = nanoid();

        // Create document from current state
        const doc = createDocumentFromPageStore(newId, name);

        // Extract blob references from rich text content and shapes
        const richTextBlobs = doc.richTextContent ? extractBlobIds(doc.richTextContent) : [];
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
        });

        // Register in document registry and set as active
        const metadata = getDocumentMetadata(doc);
        if (!doc.isTeamDocument) {
          useDocumentRegistry.getState().registerLocal(metadata);
        }
        useDocumentRegistry.getState().setActiveDocument(id);
        useDocumentRegistry.getState().setDocumentContent(id, doc);

        // Switch collaboration session to this document if active
        const collabStore = useCollaborationStore.getState();
        if (collabStore.isActive) {
          collabStore.switchDocument(id);
        }

        // Save current document ID
        localStorage.setItem(STORAGE_KEYS.CURRENT_DOCUMENT, id);

        return true;
      },

      // Delete a document by ID
      deleteDocument: (id: string) => {
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

      // Rename the current document
      renameDocument: (name: string) => {
        const state = get();
        const docId = state.currentDocumentId;

        set({ currentDocumentName: name, isDirty: true });

        // If document is saved, update metadata
        if (docId && state.documents[docId]) {
          const existingMeta = state.documents[docId];
          const updatedMeta: DocumentMetadata = {
            ...existingMeta,
            name,
          };
          set({
            documents: {
              ...state.documents,
              [docId]: updatedMeta,
            },
          });

          // Also update the document registry for reactivity
          useDocumentRegistry.getState().updateRecord(docId, { name });
        }
      },

      // Export current document as JSON
      exportJSON: (): string => {
        const state = get();
        const docId = state.currentDocumentId ?? nanoid();

        const doc = createDocumentFromPageStore(docId, state.currentDocumentName);

        // Extract blob references from rich text content and shapes
        const richTextBlobs = doc.richTextContent ? extractBlobIds(doc.richTextContent) : [];
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

      // Transfer a personal document to team documents
      transferToTeam: (docId: string): boolean => {
        // Load the document
        const doc = loadDocumentFromStorage(docId);
        if (!doc) {
          console.warn(`Document ${docId} not found for transfer`);
          return false;
        }

        // Already a team document
        if (doc.isTeamDocument) {
          console.warn(`Document ${docId} is already a team document`);
          return false;
        }

        // Get current user for ownership
        const currentUser = useUserStore.getState().currentUser;

        // Update team fields
        doc.isTeamDocument = true;
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

        // Save to host/server
        const serverMode = useTeamStore.getState().serverMode;

        if (serverMode === 'host' && isTauri()) {
          // Host mode: save directly to Rust DocumentStore via Tauri command
          import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke('save_team_document', { document: doc })
              .then(() => {
                console.log('[persistenceStore] Saved team document to host:', doc.id);
              })
              .catch((error) => {
                console.error('[persistenceStore] Failed to save team document to host:', error);
              });
          });
        } else if (serverMode === 'client') {
          // Client mode: save via WebSocket to host
          const teamDocStore = useTeamDocumentStore.getState();
          if (teamDocStore.authenticated) {
            teamDocStore.saveToHost(doc).catch((error) => {
              console.error('[persistenceStore] Failed to save team document to host:', error);
            });
          }
        }

        return true;
      },

      // Transfer a team document to personal documents
      transferToPersonal: (docId: string): boolean => {
        // Load the document
        const doc = loadDocumentFromStorage(docId);
        if (!doc) {
          console.warn(`Document ${docId} not found for transfer`);
          return false;
        }

        // Not a team document
        if (!doc.isTeamDocument) {
          console.warn(`Document ${docId} is already a personal document`);
          return false;
        }

        // If connected to host, delete from host first
        const teamStore = useTeamDocumentStore.getState();
        if (teamStore.authenticated && teamStore.isTeamDocument(docId)) {
          teamStore.deleteFromHost(docId).catch((error) => {
            console.error('Failed to delete team document from host:', error);
          });
        }

        // Clear team-specific fields
        doc.isTeamDocument = false;
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

      // Load a remote document (from host) directly into the editor
      loadRemoteDocument: (doc: DiagramDocument) => {
        // Ensure team document flag is set for documents loaded from host
        const docWithTeamFlag = {
          ...doc,
          isTeamDocument: true,
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

        // Switch collaboration session to this document
        // This ensures CRDT sync happens for the correct document
        const collabStore = useCollaborationStore.getState();
        if (collabStore.isActive) {
          collabStore.switchDocument(docWithTeamFlag.id);
        }

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
    if (!registry.hasDocument(id) && !metadata.isTeamDocument) {
      registry.registerLocal(metadata);
    }
  }

  // Try to load the last opened document
  const lastDocId = localStorage.getItem(STORAGE_KEYS.CURRENT_DOCUMENT);

  if (lastDocId && store.documentExists(lastDocId)) {
    const success = store.loadDocument(lastDocId);
    if (success) return;
  }

  // No last document or failed to load - create new document
  store.newDocument();
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
