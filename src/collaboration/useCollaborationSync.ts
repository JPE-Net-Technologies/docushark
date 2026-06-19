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
import { useReferenceStore } from '../store/referenceStore';
import { useFieldStore } from '../store/fieldStore';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import { usePageStore } from '../store/pageStore';
import { useSessionStore } from '../store/sessionStore';
import { applyRemoteDocumentName } from '../store/persistenceStore';
import { isAutoSaveSuppressed } from '../store/autoSaveGuard';
import { getProvenance, runWithProvenance } from '../store/writeProvenance';
import { useCollaborationStore, useIsRelaySessionLive } from './collaborationStore';
import { canvasPageGuarded, isCanvasPageGuarded } from './canvasPageGuard';
import type { YjsDocument, ProsePageMeta, CanvasPageMeta } from './YjsDocument';

/**
 * Adopt the relay's authoritative prose page LIST into `richTextPagesStore`
 * (JP-339), but only when non-empty — an empty list means the relay carries no
 * prose page list (a never-had-prose doc), where the local default-page
 * bootstrap (`rt-page-1`) must stand rather than be wiped. Caller runs this
 * inside a `remote-apply` provenance window so the local→CRDT subscription
 * skips the echo.
 */
function adoptProsePageList(yjsDoc: YjsDocument): void {
  const list = yjsDoc.getProsePageList();
  if (list.pageOrder.length === 0) return;
  useRichTextPagesStore.getState().applyRemoteProsePageList(list);
}

/**
 * Adopt the relay's authoritative canvas page LIST into `pageStore` (JP-339),
 * but only when non-empty — an empty list means the relay carries no canvas page
 * list, where the local pages (loaded from the JSON snapshot) stand. Caller runs
 * this inside a `remote-apply` provenance window so the local→CRDT subscription
 * skips the echo.
 */
function adoptCanvasPageList(yjsDoc: YjsDocument): void {
  const list = yjsDoc.getCanvasPageList();
  if (list.pageOrder.length === 0) return;
  usePageStore.getState().applyRemoteCanvasPageList(list);
}

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
  const syncReference = useCollaborationStore((state) => state.syncReference);
  const syncDeleteReference = useCollaborationStore((state) => state.syncDeleteReference);
  const syncReferenceStyle = useCollaborationStore((state) => state.syncReferenceStyle);
  const syncField = useCollaborationStore((state) => state.syncField);
  const syncDeleteField = useCollaborationStore((state) => state.syncDeleteField);
  const syncProsePage = useCollaborationStore((state) => state.syncProsePage);
  const syncDeleteProsePage = useCollaborationStore((state) => state.syncDeleteProsePage);
  const syncProsePageOrder = useCollaborationStore((state) => state.syncProsePageOrder);
  const syncCanvasPage = useCollaborationStore((state) => state.syncCanvasPage);
  const syncDeleteCanvasPage = useCollaborationStore((state) => state.syncDeleteCanvasPage);
  const syncCanvasPageOrder = useCollaborationStore((state) => state.syncCanvasPageOrder);

  // Track if we've initialized for this session
  const initializedRef = useRef(false);

  // JP-341: mirror the canvas page-guard into the single `canvasReadOnly` flag
  // (sessionStore) that the engine + UI read. The guard is on when an online relay
  // session is bound to a different page than the one currently active — editing
  // it would flatten shapes onto the relay's hydrated page (JP-340). Recomputed
  // reactively from relay-live + the bound page + the active page.
  const relayLive = useIsRelaySessionLive();
  const relayPageId = useCollaborationStore((state) => state.relayPageId);
  const activePageId = usePageStore((state) => state.activePageId);
  useEffect(() => {
    useSessionStore
      .getState()
      .setCanvasReadOnly(canvasPageGuarded({ relayLive, relayPageId, activePageId }));
  }, [relayLive, relayPageId, activePageId]);

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

    // Handle remote reference-library changes (JP-89). Coarse bulk reload from
    // the merged Y.Doc snapshot — `runWithProvenance('remote-apply')` so the
    // local referenceStore→Y.Doc subscription below skips it (no echo loop).
    const unsubRefs = yjsDoc.onReferenceChange(() => {
      runWithProvenance('remote-apply', () => {
        useReferenceStore.getState().loadReferences(yjsDoc.getReferenceLibrary());
      });
    });

    // Handle remote field-library changes (Phase 3b). Same coarse bulk-reload
    // pattern as references — `remote-apply` so the local fieldStore→Y.Doc
    // subscription below skips it (no echo loop).
    const unsubFields = yjsDoc.onFieldChange(() => {
      runWithProvenance('remote-apply', () => {
        useFieldStore.getState().loadFields(yjsDoc.getFieldLibrary());
      });
    });

    // Handle remote prose page-LIST changes (JP-339). Coarse bulk-merge from the
    // merged Y.Doc snapshot — `remote-apply` so the local richTextPagesStore→Y.Doc
    // subscription below skips it (no echo loop). The merge preserves each page's
    // already-synced `content`, so an MCP-added tab appears live without reload
    // and without clobbering prose. Skipped when the list is empty: an empty map
    // is "the relay has no prose page list" (a never-had-prose doc), where the
    // local default-page bootstrap (`rt-page-1`) must stand, not be wiped.
    const unsubProsePages = yjsDoc.onProsePagesChange(() => {
      const list = yjsDoc.getProsePageList();
      if (list.pageOrder.length === 0) return;
      runWithProvenance('remote-apply', () => {
        useRichTextPagesStore.getState().applyRemoteProsePageList(list);
      });
    });

    // Handle remote canvas page-LIST changes (JP-339). Coarse bulk-merge from the
    // merged Y.Doc snapshot — `remote-apply` so the local pageStore→Y.Doc
    // subscription below skips it. The merge preserves each page's shapes, so an
    // MCP-added tab appears live without reload. Skipped when empty (the local
    // JSON-loaded pages stand).
    const unsubCanvasPages = yjsDoc.onCanvasPagesChange(() => {
      const list = yjsDoc.getCanvasPageList();
      if (list.pageOrder.length === 0) return;
      runWithProvenance('remote-apply', () => {
        usePageStore.getState().applyRemoteCanvasPageList(list);
      });
    });

    return () => {
      unsubShapes();
      unsubOrder();
      unsubMeta();
      unsubRefs();
      unsubFields();
      unsubProsePages();
      unsubCanvasPages();
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
        // JP-89: adopt the authoritative reference library too.
        useReferenceStore.getState().loadReferences(yjsDoc.getReferenceLibrary());
        // Phase 3b: adopt the authoritative field library too.
        useFieldStore.getState().loadFields(yjsDoc.getFieldLibrary());
        // JP-339: adopt the authoritative prose page LIST (tab metadata), so a
        // joining client picks up pages/renames/reorders made before it
        // connected. Only when non-empty — an empty list means the relay has no
        // prose page list yet, where the local default-page bootstrap stands.
        adoptProsePageList(yjsDoc);
        // JP-339: adopt the authoritative canvas page LIST (tab metadata) too,
        // preserving each page's shapes.
        adoptCanvasPageList(yjsDoc);
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
        // JP-89: a doc can be empty of shapes but carry a reference library
        // (prose + citations, no diagram) — adopt it here too.
        useReferenceStore.getState().loadReferences(yjsDoc.getReferenceLibrary());
        // Phase 3b: a prose-only doc can carry fields with no shapes — adopt too.
        useFieldStore.getState().loadFields(yjsDoc.getFieldLibrary());
        // JP-339: a prose-only doc carries its page list with no shapes — adopt.
        adoptProsePageList(yjsDoc);
        // JP-339: adopt the canvas page list even on an empty-shapes doc (a
        // multi-page doc whose active page happens to be empty still has tabs).
        adoptCanvasPageList(yjsDoc);
      });
      initializedRef.current = true;
    }
    // else: offline + empty Y.Doc — defer (leave `initializedRef` false). The
    // doc-store→CRDT subscription below stays gated off so an edit can't fork a
    // new identity; the engine will adopt once it goes online and syncs.

    // JP-338 prose self-heal: once the Y.Doc holds the complete (idb+relay)
    // truth, collapse any prose page that came back doubled — a stale
    // y-indexeddb lineage (a cached live write) meeting the relay's deterministic
    // seed concatenates `body+body`. The collapse is a CRDT delete, so it
    // propagates to the relay + peers and heals everyone. No-op on clean docs.
    if (initializedRef.current) {
      for (const pageId of useRichTextPagesStore.getState().pageOrder) {
        yjsDoc.healDoubledProse(pageId);
      }
    }
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

        // Belt-and-suspenders, deliberately KEPT (JP-194): also skip while
        // autosave is suppressed. This is COARSER than the provenance gate above
        // — `withAutoSaveSuppressed` covers the entire doc-load block
        // (`loadDocumentToPageStore`), whereas `'load'` provenance only covers the
        // synchronous `documentStore.loadSnapshot`/`clear` window. Any store write
        // during a load that doesn't route through those would slip the precise
        // gate but not this one. It caused painful CRDT debugging once; it stays
        // as cheap insurance against the #59 mass-deletion class.
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

        // JP-341 canvas page-guard (the corruption guarantee): when the client's
        // active canvas page differs from the page the relay's active-page-only
        // surface is bound to, a shape edit here would flatten onto the WRONG page.
        // Skip the sync entirely so no off-page edit reaches the relay — from ANY
        // path (tool, property panel, paste, programmatic). The input gates
        // (read-only canvas) stop the user making such edits in the first place;
        // this is the structural backstop. Prose/field/reference are per-page-safe
        // and intentionally NOT gated here.
        if (isCanvasPageGuarded()) return;

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

  // Subscribe to local reference-library changes and sync to the CRDT (JP-89).
  // Mirrors the shape subscription: same provenance + autosave-suppression +
  // initialized gates, and a per-item diff (INVARIANT A — `set`/`delete` by id,
  // never a whole-map rewrite) so a concurrent MCP/peer add is never clobbered.
  useEffect(() => {
    if (!isActive) return undefined;

    const unsubscribe = useReferenceStore.subscribe((state, prevState) => {
      const provenance = getProvenance();
      if (provenance === 'remote-apply' || provenance === 'load') return;
      if (isAutoSaveSuppressed()) return;
      if (!useCollaborationStore.getState().isActive) return;
      if (!initializedRef.current) return;

      const curIds = new Set(Object.keys(state.items));
      const prevIds = new Set(Object.keys(prevState.items));

      // Added or updated items → per-item set.
      for (const id of curIds) {
        const cur = state.items[id];
        if (!cur) continue;
        if (!prevIds.has(id) || cur !== prevState.items[id]) syncReference(cur);
      }
      // Deleted items → per-item delete.
      for (const id of prevIds) {
        if (!curIds.has(id)) syncDeleteReference(id);
      }
      // Active style change.
      if (state.activeStyle !== prevState.activeStyle) syncReferenceStyle(state.activeStyle);
    });

    return unsubscribe;
  }, [isActive, syncReference, syncDeleteReference, syncReferenceStyle]);

  // Subscribe to local field-library changes and sync to the CRDT (Phase 3b).
  // Mirrors the reference subscription: same provenance + autosave-suppression +
  // initialized gates, and a per-item diff by NAME (INVARIANT A — `set`/`delete`,
  // never a whole-map rewrite) so a concurrent MCP/peer set is never clobbered.
  // Computed fields (today/now) never enter `fieldStore.fields`, so they're never
  // synced — by design (each client resolves them live).
  useEffect(() => {
    if (!isActive) return undefined;

    const unsubscribe = useFieldStore.subscribe((state, prevState) => {
      const provenance = getProvenance();
      if (provenance === 'remote-apply' || provenance === 'load') return;
      if (isAutoSaveSuppressed()) return;
      if (!useCollaborationStore.getState().isActive) return;
      if (!initializedRef.current) return;

      const curNames = new Set(Object.keys(state.fields));
      const prevNames = new Set(Object.keys(prevState.fields));

      // Added or value-changed fields → per-item set.
      for (const name of curNames) {
        const cur = state.fields[name];
        if (!cur) continue;
        if (!prevNames.has(name) || cur !== prevState.fields[name]) syncField(cur);
      }
      // Deleted fields → per-item delete.
      for (const name of prevNames) {
        if (!curNames.has(name)) syncDeleteField(name);
      }
    });

    return unsubscribe;
  }, [isActive, syncField, syncDeleteField]);

  // Subscribe to local prose page-LIST changes and sync to the CRDT (JP-339).
  // Mirrors the reference/field subscriptions: same provenance +
  // autosave-suppression + initialized gates. The diff is META-ONLY — page
  // `content` has its own `prose:<id>` channel, so we compare name/color and set
  // membership (NOT object identity, which `updatePageContent` would churn) and
  // sync the tab order separately. A page-switch (`setActivePage`) only moves
  // `activePageId` — which is deliberately client-local — so it produces no sync.
  useEffect(() => {
    if (!isActive) return undefined;

    const unsubscribe = useRichTextPagesStore.subscribe((state, prevState) => {
      const provenance = getProvenance();
      if (provenance === 'remote-apply' || provenance === 'load') return;
      if (isAutoSaveSuppressed()) return;
      if (!useCollaborationStore.getState().isActive) return;
      if (!initializedRef.current) return;

      const curIds = new Set(Object.keys(state.pages));
      const prevIds = new Set(Object.keys(prevState.pages));

      // Added or metadata-changed pages → per-item set (ignore `content`).
      state.pageOrder.forEach((id, index) => {
        const cur = state.pages[id];
        if (!cur) return;
        const prev = prevState.pages[id];
        const metaChanged =
          !prev || prev.name !== cur.name || prev.color !== cur.color || prev.order !== cur.order;
        if (metaChanged) {
          const meta: ProsePageMeta = {
            id,
            name: cur.name,
            order: index,
            createdAt: cur.createdAt,
            modifiedAt: cur.modifiedAt,
          };
          if (cur.color !== undefined) meta.color = cur.color;
          syncProsePage(meta);
        }
      });

      // Deleted pages → per-item delete.
      for (const id of prevIds) {
        if (!curIds.has(id)) syncDeleteProsePage(id);
      }

      // Tab reorder → rewrite the order array (mirrors shapeOrder).
      if (state.pageOrder !== prevState.pageOrder) {
        syncProsePageOrder(state.pageOrder);
      }
    });

    return unsubscribe;
  }, [isActive, syncProsePage, syncDeleteProsePage, syncProsePageOrder]);

  // Subscribe to local canvas page-LIST changes and sync to the CRDT (JP-339).
  // Mirrors the prose page-list subscription: same provenance +
  // autosave-suppression + initialized gates. The diff is META-ONLY — a page's
  // `shapes`/`shapeOrder` have their own active-page channel (the documentStore
  // subscription above), so we compare `name` and set membership (NOT object
  // identity, which a shape-save into `pages[active]` would churn) and sync the
  // tab order separately. A page-switch (`setActivePage`) only moves
  // `activePageId` (kept client-local) + saves shapes — neither is a meta change,
  // so no sync.
  useEffect(() => {
    if (!isActive) return undefined;

    const unsubscribe = usePageStore.subscribe((state, prevState) => {
      const provenance = getProvenance();
      if (provenance === 'remote-apply' || provenance === 'load') return;
      if (isAutoSaveSuppressed()) return;
      if (!useCollaborationStore.getState().isActive) return;
      if (!initializedRef.current) return;

      const curIds = new Set(Object.keys(state.pages));
      const prevIds = new Set(Object.keys(prevState.pages));

      // Added or renamed pages → per-item set (ignore shapes/shapeOrder).
      for (const id of curIds) {
        const cur = state.pages[id];
        if (!cur) continue;
        const prev = prevState.pages[id];
        if (!prev || prev.name !== cur.name) {
          const meta: CanvasPageMeta = {
            id,
            name: cur.name,
            createdAt: cur.createdAt,
            modifiedAt: cur.modifiedAt,
          };
          syncCanvasPage(meta);
        }
      }

      // Deleted pages → per-item delete.
      for (const id of prevIds) {
        if (!curIds.has(id)) syncDeleteCanvasPage(id);
      }

      // Tab reorder → rewrite the order array (mirrors shapeOrder).
      if (state.pageOrder !== prevState.pageOrder) {
        syncCanvasPageOrder(state.pageOrder);
      }
    });

    return unsubscribe;
  }, [isActive, syncCanvasPage, syncDeleteCanvasPage, syncCanvasPageOrder]);
}

/**
 * Check if collaboration sync is currently applying remote changes.
 * Useful for preventing redundant operations.
 */
export function isRemoteSyncInProgress(): boolean {
  return getProvenance() === 'remote-apply';
}

export default useCollaborationSync;
