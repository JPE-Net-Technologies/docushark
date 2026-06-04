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
import { applyRemoteDocumentName } from '../store/persistenceStore';
import { isAutoSaveSuppressed } from '../store/autoSaveGuard';
import { getProvenance, runWithProvenance } from '../store/writeProvenance';
import { useCollaborationStore } from './collaborationStore';

/**
 * Hook that manages bidirectional sync between CRDT and document store.
 *
 * Call this hook once at the app root level to enable collaboration sync.
 */
export function useCollaborationSync(): void {
  const isActive = useCollaborationStore((state) => state.isActive);
  const isSynced = useCollaborationStore((state) => state.isSynced);
  const isIdbSynced = useCollaborationStore((state) => state.isIdbSynced);
  // A WS provider is attached only when the session has a token (engine ≠
  // provider, JP-108 step 3). Offline / pre-sign-in there is no provider, so
  // `isSynced` never flips — the adopt must instead key off the local
  // `y-indexeddb` load alone (the Y.Doc IS the complete truth with no relay to
  // merge). `config.token` is the reactive proxy for "provider attached".
  const hasProvider = useCollaborationStore((state) => state.config?.token != null);
  const getYjsDocument = useCollaborationStore((state) => state.getYjsDocument);
  // Bumped per startSession (incl. switchDocument's restart) — drives the view
  // effects to re-bind to the new YjsDocument instance.
  const sessionEpoch = useCollaborationStore((state) => state.sessionEpoch);
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

    // This effect re-runs whenever `sessionEpoch` bumps — i.e. a NEW YjsDocument
    // instance (switchDocument restart). Reset `initializedRef` so the adopt
    // effect re-runs against the new instance; otherwise it stays `true` from
    // the previous session and the new doc is never adopted into the view.
    initializedRef.current = false;

    // Handle remote shape changes
    const unsubShapes = yjsDoc.onShapeChange((added, updated, removed) => {
      runWithProvenance('remote-apply', () => {
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
      });
    });

    // Handle remote order changes
    const unsubOrder = yjsDoc.onOrderChange((order) => {
      runWithProvenance('remote-apply', () => {
        useDocumentStore.getState().reorderShapes(order);
      });
    });

    // Handle remote document-name changes (CRDT-native rename). The name lives
    // in the Y.Doc `metadata` map (`title`); apply it to local state without
    // writing back (applyRemoteDocumentName is local-only, so no loop).
    const unsubMeta = yjsDoc.onMetadataChange(() => {
      const docId = useCollaborationStore.getState().config?.documentId;
      const name = yjsDoc.getName(); // raw, no "Untitled" default
      if (docId && name) applyRemoteDocumentName(docId, name);
    });

    return () => {
      unsubShapes();
      unsubOrder();
      unsubMeta();
    };
  }, [isActive, getYjsDocument, sessionEpoch]);

  // Initialize the views from the Y.Doc once it holds the *complete* truth.
  //
  // - With a provider attached (online), that means BOTH the relay sync
  //   (`isSynced`) AND the local `y-indexeddb` load (`isIdbSynced`).
  // - With no provider (offline / pre-sign-in, JP-108 step 3 Stage 2), there is
  //   no relay to merge, so the complete truth is just the `y-indexeddb` state —
  //   adopt as soon as `isIdbSynced`.
  //
  // Adopting earlier would clobber the views with a partial Y.Doc.
  useEffect(() => {
    if (!isActive || !isIdbSynced || initializedRef.current) return;
    // Online: also wait for the relay's authoritative state before adopting.
    if (hasProvider && !isSynced) return;

    const yjsDoc = getYjsDocument();
    if (!yjsDoc) return;

    // Check if the Y.Doc has data (persisted IndexedDB state and/or relay state).
    const crdtShapes = yjsDoc.getAllShapes();

    if (crdtShapes.size > 0) {
      // The Y.Doc is the complete truth — replace the views with it. Safe in
      // both modes: online it's the idb+relay merge, offline it's the persisted
      // state for this exact doc's room.
      runWithProvenance('remote-apply', () => {
        const store = useDocumentStore.getState();
        store.clear();
        store.addShapes(Array.from(crdtShapes.values()));
        const crdtOrder = yjsDoc.getShapeOrder();
        if (crdtOrder.length > 0) {
          store.reorderShapes(crdtOrder);
        }
      });
      // Adopt the relay's authoritative document name too (CRDT-native rename),
      // so a joining client picks up a rename made before it connected.
      const docId = useCollaborationStore.getState().config?.documentId;
      const name = yjsDoc.getName(); // raw, no "Untitled" default
      if (docId && name) applyRemoteDocumentName(docId, name);
      initializedRef.current = true;
    } else if (isSynced) {
      // The Y.Doc is empty AND the relay confirmed its state (`isSynced`) — the
      // doc is genuinely empty on the relay (the authoritative source). The
      // local view's cached shapes, if any, are stale, so ADOPT TO EMPTY: clear
      // only the VIEW. The Y.Doc is now the established (empty) truth and READY
      // FOR EDITS, so mark initialized — otherwise the doc-store→CRDT
      // subscription stays gated off and no edits ever reach the relay.
      //
      // We deliberately do NOT seed via `initializeFromState` here (JP-179): it
      // calls `shapes.clear()` on the SHARED Y.Doc, and with a provider attached
      // that broadcasts a CRDT deletion that wipes every peer's shapes (a proven
      // hazard — see seedClobber.proof.test.ts). A genuinely-new/just-promoted
      // doc never reaches this branch: its REST `saveToHost` populates the relay
      // first, so it syncs in via the `crdtShapes.size > 0` adopt above. Offline
      // (`!hasProvider`) never reaches here either (isSynced is false).
      runWithProvenance('remote-apply', () => {
        useDocumentStore.getState().clear();
      });
      initializedRef.current = true;
    }
    // else: offline + empty Y.Doc — defer (leave `initializedRef` false). The
    // doc-store→CRDT subscription below stays gated off so an edit can't fork a
    // new identity; the engine will adopt once it goes online and syncs.
  }, [isActive, isSynced, isIdbSynced, hasProvider, getYjsDocument, sessionEpoch]);

  // Subscribe to local document store changes and sync to CRDT
  useEffect(() => {
    if (!isActive) return;

    // Subscribe to document store changes
    const unsubscribe = useDocumentStore.subscribe(
      (state, prevState) => {
        // Propagate only human-authored deltas. `remote-apply` is the bridge
        // re-applying an inbound CRDT change (skipping it prevents sync loops);
        // `load` is a programmatic whole-store load/replace — a document load,
        // page-switch, or undo/redo snapshot restore wipes-and-reloads
        // documentStore via `loadSnapshot`/`clear`. Diffing either as user edits
        // would broadcast CRDT tombstones to every client (the #59 mass-deletion
        // bug, JP-178/JP-192). `user-edit` and `programmatic` fall through and
        // propagate. This is the structural guarantee — no caller need remember
        // to set a suppression flag.
        const provenance = getProvenance();
        if (provenance === 'remote-apply' || provenance === 'load') return;

        // Belt-and-suspenders: also skip while autosave is suppressed (a load
        // replaying content). `loadDocumentToPageStore` wraps loads in
        // `withAutoSaveSuppressed`; this still gates any non-bulk *edit* action
        // dispatched inside a suppressed block, and serves autosave's own needs.
        if (isAutoSaveSuppressed()) return;

        // Skip if collaboration not active
        if (!useCollaborationStore.getState().isActive) return;

        // Skip until the Y.Doc is the established truth (adopted/seeded). Pushing
        // edits into a not-yet-initialized Y.Doc would give them fresh CRDT
        // identities — for a relay-origin doc that hasn't synced yet, those
        // duplicate every shape on the first sync (JP-108 step 3 hard
        // constraint). Once `initializedRef` is set the Y.Doc owns the content
        // and live edits flow normally.
        if (!initializedRef.current) return;

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

        // Tripwire (JP-178): a wholesale deletion (N>0 → 0) reaching the CRDT on
        // 'edit' provenance is either a genuine select-all+delete (fine) or a
        // future bulk path that forgot the 'replace' tag (a regression). We
        // can't distinguish them without per-op provenance, so this is a
        // dev-only, NON-blocking canary — never block, a real delete-all must
        // still propagate. The guarantee is the 'replace' guard above; this is
        // just an early-warning signal.
        if (
          import.meta.env.DEV &&
          prevIds.size > 0 &&
          currentIds.size === 0
        ) {
          // eslint-disable-next-line no-console
          console.error(
            '[useCollaborationSync] wholesale deletion propagated to the CRDT ' +
              `(${prevIds.size} → 0 shapes). Expected only on a user select-all+delete; ` +
              'if this fired during a load/page-switch/teardown, a bulk path is ' +
              "missing the documentStore 'replace' tag (JP-178).",
          );
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
  return getProvenance() === 'remote-apply';
}

export default useCollaborationSync;
