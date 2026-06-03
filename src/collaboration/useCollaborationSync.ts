/**
 * Hook for bidirectional sync between collaboration CRDT and document store.
 *
 * This hook:
 * 1. Subscribes to remote changes from CRDT and applies them to documentStore
 * 2. Subscribes to local documentStore changes and syncs them to CRDT
 * 3. Handles initialization when joining a collaboration session
 *
 * Usage:
 * ```typescript
 * function App() {
 *   useCollaborationSync();
 *   // ... rest of app
 * }
 * ```
 */

import { useEffect, useRef } from 'react';
import { useDocumentStore } from '../store/documentStore';
import { useCollaborationStore } from './collaborationStore';

/**
 * Flag to prevent sync loops.
 * When applying remote changes, we don't want to re-sync them back.
 */
let isApplyingRemoteChanges = false;

/**
 * Hook that manages bidirectional sync between CRDT and document store.
 *
 * Call this hook once at the app root level to enable collaboration sync.
 */
export function useCollaborationSync(): void {
  const isActive = useCollaborationStore((state) => state.isActive);
  const isSynced = useCollaborationStore((state) => state.isSynced);
  const isIdbSynced = useCollaborationStore((state) => state.isIdbSynced);
  const getYjsDocument = useCollaborationStore((state) => state.getYjsDocument);
  const syncShape = useCollaborationStore((state) => state.syncShape);
  const syncDeleteShape = useCollaborationStore((state) => state.syncDeleteShape);
  const syncShapeOrder = useCollaborationStore((state) => state.syncShapeOrder);

  // Track if we've initialized for this session
  const initializedRef = useRef(false);

  // Subscribe to remote CRDT changes and apply to local store
  useEffect(() => {
    if (!isActive) {
      initializedRef.current = false;
      return;
    }

    const yjsDoc = getYjsDocument();
    if (!yjsDoc) return;

    // Handle remote shape changes
    const unsubShapes = yjsDoc.onShapeChange((added, updated, removed) => {
      isApplyingRemoteChanges = true;
      try {
        const store = useDocumentStore.getState();

        // Add new shapes
        if (added.length > 0) {
          store.addShapes(added);
        }

        // Update existing shapes
        for (const shape of updated) {
          store.updateShape(shape.id, shape);
        }

        // Remove deleted shapes
        if (removed.length > 0) {
          store.deleteShapes(removed);
        }
      } finally {
        isApplyingRemoteChanges = false;
      }
    });

    // Handle remote order changes
    const unsubOrder = yjsDoc.onOrderChange((order) => {
      isApplyingRemoteChanges = true;
      try {
        useDocumentStore.getState().reorderShapes(order);
      } finally {
        isApplyingRemoteChanges = false;
      }
    });

    return () => {
      unsubShapes();
      unsubOrder();
    };
  }, [isActive, getYjsDocument]);

  // Initialize the views from the Y.Doc once the session has the *complete*
  // merged truth — gated on BOTH the relay sync (`isSynced`) AND the local
  // `y-indexeddb` load (`isIdbSynced`, JP-108 step 3). Adopting before both
  // would clobber the views with a partial Y.Doc (missing persisted offline
  // edits or relay state).
  useEffect(() => {
    if (!isActive || !isSynced || !isIdbSynced || initializedRef.current) return;

    const yjsDoc = getYjsDocument();
    if (!yjsDoc) return;

    // Get current document state
    const { shapes, shapeOrder } = useDocumentStore.getState();
    const shapesArray = Object.values(shapes);

    // Check if the Y.Doc has data (persisted IndexedDB state and/or relay state).
    const crdtShapes = yjsDoc.getAllShapes();

    if (crdtShapes.size > 0) {
      // The Y.Doc is the complete merged truth — replace the views with it.
      isApplyingRemoteChanges = true;
      try {
        const store = useDocumentStore.getState();
        store.clear();
        store.addShapes(Array.from(crdtShapes.values()));
        const crdtOrder = yjsDoc.getShapeOrder();
        if (crdtOrder.length > 0) {
          store.reorderShapes(crdtOrder);
        }
      } finally {
        isApplyingRemoteChanges = false;
      }
    } else if (shapesArray.length > 0) {
      // The Y.Doc is empty AND the relay confirmed it synced empty (we waited
      // for isSynced) AND IndexedDB had nothing — so this is a genuinely empty
      // doc. Safe to seed from local without risking the duplication the
      // identity rule guards against (a non-empty relay would have populated
      // the Y.Doc above). [JP-108 step 3 — Stage 2 hardens the offline case.]
      yjsDoc.initializeFromState(shapesArray, shapeOrder);
    }

    initializedRef.current = true;
  }, [isActive, isSynced, isIdbSynced, getYjsDocument]);

  // Subscribe to local document store changes and sync to CRDT
  useEffect(() => {
    if (!isActive) return;

    // Subscribe to document store changes
    const unsubscribe = useDocumentStore.subscribe(
      (state, prevState) => {
        // Skip if we're applying remote changes (prevents sync loops)
        if (isApplyingRemoteChanges) return;

        // Skip if collaboration not active
        if (!useCollaborationStore.getState().isActive) return;

        // Detect shape changes
        const currentIds = new Set(Object.keys(state.shapes));
        const prevIds = new Set(Object.keys(prevState.shapes));

        // Find added shapes
        for (const id of currentIds) {
          if (!prevIds.has(id)) {
            const shape = state.shapes[id];
            if (shape) syncShape(shape);
          }
        }

        // Find updated shapes
        for (const id of currentIds) {
          if (prevIds.has(id)) {
            const current = state.shapes[id];
            const prev = prevState.shapes[id];
            // Simple reference check - if different object, sync it
            if (current && current !== prev) {
              syncShape(current);
            }
          }
        }

        // Find deleted shapes
        for (const id of prevIds) {
          if (!currentIds.has(id)) {
            syncDeleteShape(id);
          }
        }

        // Sync shape order if changed
        if (state.shapeOrder !== prevState.shapeOrder) {
          syncShapeOrder(state.shapeOrder);
        }
      }
    );

    return unsubscribe;
  }, [isActive, syncShape, syncDeleteShape, syncShapeOrder]);
}

/**
 * Check if collaboration sync is currently applying remote changes.
 * Useful for preventing redundant operations.
 */
export function isRemoteSyncInProgress(): boolean {
  return isApplyingRemoteChanges;
}

export default useCollaborationSync;
