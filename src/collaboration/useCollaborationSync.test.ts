/**
 * Hook-level tests for useCollaborationSync — the collab sync orchestration that
 * had ZERO coverage and produced three data-loss bugs in one session (JP-181):
 *   - #59: a document LOAD must not propagate as CRDT deletions.
 *   - #60: view effects must re-bind when the Y.Doc instance is replaced.
 *   - JP-179: adopt-to-empty (never seed a connected doc).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Shape } from '../shapes/Shape';

// ---- Controllable mock Y.Doc -------------------------------------------------
// One mock instance per `new YjsDocument()`; the latest is exposed as `currentYjs`.
let currentYjs: ReturnType<typeof makeMockYjs>;
function makeMockYjs() {
  const shapeCbs = new Set<(a: Shape[], u: Shape[], r: string[]) => void>();
  return {
    _shapeCbs: shapeCbs,
    getDoc: () => ({}),
    getAllShapes: vi.fn(() => new Map<string, Shape>()),
    getShapeOrder: vi.fn(() => [] as string[]),
    // JP-340 per-page binding surface.
    hasAnyShapes: vi.fn(() => false),
    rebindActivePage: vi.fn(() => ({ shapes: [] as Shape[], order: [] as string[] })),
    // JP-335 pending-page handoff surface.
    seedPageShapes: vi.fn(),
    // JP-338 self-heal (runs over the prose page list after adopt).
    healDoubledProse: vi.fn(),
    getShapesForPage: vi.fn(() => [] as Shape[]),
    getShapeOrderForPage: vi.fn(() => [] as string[]),
    getName: vi.fn(() => undefined),
    setShape: vi.fn(),
    setShapes: vi.fn(),
    deleteShape: vi.fn(),
    setShapeOrder: vi.fn(),
    setMetadata: vi.fn(),
    clear: vi.fn(),
    destroy: vi.fn(),
    initializeFromState: vi.fn(),
    // JP-402 canvas undo/redo surface.
    onUndoStackChange: vi.fn(() => () => {}),
    undo: vi.fn(),
    redo: vi.fn(),
    canUndo: vi.fn(() => false),
    canRedo: vi.fn(() => false),
    closeUndoStep: vi.fn(),
    clearUndoHistory: vi.fn(),
    onShapeChange: vi.fn((cb: (a: Shape[], u: Shape[], r: string[]) => void) => {
      shapeCbs.add(cb);
      return () => shapeCbs.delete(cb);
    }),
    onOrderChange: vi.fn(() => () => {}),
    onMetadataChange: vi.fn(() => () => {}),
    // JP-89 reference-library binding surface.
    onReferenceChange: vi.fn(() => () => {}),
    getReferenceLibrary: vi.fn(() => ({ items: {}, itemOrder: [] })),
    setReference: vi.fn(),
    deleteReference: vi.fn(),
    setReferenceStyle: vi.fn(),
    // Phase 3b field-library binding surface.
    onFieldChange: vi.fn(() => () => {}),
    getFieldLibrary: vi.fn(() => ({ fields: {}, order: [] })),
    setField: vi.fn(),
    deleteField: vi.fn(),
    // JP-339 prose page-list binding surface.
    onProsePagesChange: vi.fn(() => () => {}),
    getProsePageList: vi.fn(() => ({ pages: {}, pageOrder: [] })),
    setProsePage: vi.fn(),
    deleteProsePage: vi.fn(),
    setProsePageOrder: vi.fn(),
    // JP-339 canvas page-list binding surface.
    onCanvasPagesChange: vi.fn(() => () => {}),
    getCanvasPageList: vi.fn(() => ({ pages: {}, pageOrder: [] })),
    setCanvasPage: vi.fn(),
    deleteCanvasPage: vi.fn(),
    setCanvasPageOrder: vi.fn(),
  };
}

vi.mock('./YjsDocument', () => ({
  YjsDocument: vi.fn(() => {
    currentYjs = makeMockYjs();
    return currentYjs;
  }),
}));
vi.mock('./UnifiedSyncProvider', () => ({
  UnifiedSyncProvider: vi.fn(() => ({
    connect: vi.fn(),
    destroy: vi.fn(),
    isReady: () => false,
    setLocalAwareness: vi.fn(),
    onAwarenessChange: () => () => {},
    updateCursor: vi.fn(),
    updateSelection: vi.fn(),
    joinDocument: vi.fn(),
    requestSync: vi.fn(),
  })),
}));
vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: vi.fn(() => ({ whenSynced: Promise.resolve(), destroy: vi.fn() })),
}));
vi.mock('../store/relayDocumentStore', () => ({
  useRelayDocumentStore: {
    getState: () => ({
      setHostConnected: vi.fn(),
      setError: vi.fn(),
      setAuthenticated: vi.fn(),
      handleDocumentEvent: vi.fn(),
      setProvider: vi.fn(),
      clearRelayDocuments: vi.fn(),
    }),
  },
}));
vi.mock('../store/connectionStore', () => {
  const state = {
    status: 'authenticated' as const,
    setHost: vi.fn(),
    reset: vi.fn(),
    setToken: vi.fn(),
    token: null,
    tokenExpiresAt: null,
  };
  // Callable as a hook (`useConnectionStore(selector)`) AND exposes getState —
  // useIsRelaySessionLive reads it via a selector.
  const useConnectionStore = Object.assign(
    (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
    { getState: () => state, subscribe: () => () => {} },
  );
  return {
    useConnectionStore,
    isRelayAuthenticated: () => state.status === 'authenticated',
    startTokenExpirationMonitor: vi.fn(),
    stopTokenExpirationMonitor: vi.fn(),
    muteConnectionToasts: vi.fn(),
  };
});
vi.mock('../store/presenceStore', () => ({
  usePresenceStore: {
    getState: () => ({ setLocalUser: vi.fn(), clearRemoteUsers: vi.fn(), syncRemoteUsers: vi.fn() }),
  },
}));
// Avoid the heavy persistenceStore import chain; the name-apply is irrelevant here.
vi.mock('../store/persistenceStore', () => ({ applyRemoteDocumentName: vi.fn() }));

import { useCollaborationStore } from './collaborationStore';
import { useDocumentStore } from '../store/documentStore';
import { usePageStore } from '../store/pageStore';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import { usePendingSyncPages, isPagePendingSync } from '../store/pendingSyncPages';
import { useCollaborationSync } from './useCollaborationSync';
import { withAutoSaveSuppressed } from '../store/autoSaveGuard';

function shape(id: string): Shape {
  return {
    id,
    type: 'rectangle',
    position: { x: 0, y: 0 },
    size: { width: 10, height: 10 },
    rotation: 0,
    style: {},
  } as unknown as Shape;
}

/** Start an engine-only session (no token → no provider block to mock) and mark
 *  it synced, so the adopt effect runs the online path. */
function startSyncedSession(docId = 'doc-1'): void {
  // JP-340: shapes are per-page, so the adopt binds the active page. Give the
  // pageStore a single active page 'p1' (the page the mock snapshot loads into).
  act(() => {
    usePageStore.setState({
      pages: { p1: { id: 'p1', name: 'Page 1', shapes: {}, shapeOrder: [], createdAt: 0, modifiedAt: 0 } },
      pageOrder: ['p1'],
      activePageId: 'p1',
    });
  });
  act(() => {
    useCollaborationStore.getState().startSession({
      serverUrl: 'ws://localhost:9876/ws',
      documentId: docId,
      // token present so `hasProvider` is true (online adopt path) but the
      // provider internals are mocked out.
      token: 'test-token',
      user: { id: 'u', name: 'U', color: '#fff' },
    });
    useCollaborationStore.getState()._setSynced(true);
    useCollaborationStore.getState()._setIdbSynced(true);
  });
}

/** JP-340: make the mock Y.Doc report authoritative content so the adopt effect
 *  takes the `hasAnyShapes` branch and loads the active page's snapshot. */
function adoptShapes(shapes: Shape[], order: string[] = shapes.map((s) => s.id)): void {
  currentYjs.hasAnyShapes.mockReturnValue(true);
  currentYjs.rebindActivePage.mockReturnValue({ shapes, order });
}

/** JP-335: start an engine-only OFFLINE session — no token (so `hasProvider` is
 *  false, the offline-first engine) and idb-synced but NEVER relay-synced. This
 *  is the exact state when opening a PREFETCHED doc offline: the local Y.Doc
 *  room was seeded from the relay's sidecar, but the relay was never contacted
 *  this session. */
function startOfflineSession(docId = 'doc-off'): void {
  act(() => {
    usePageStore.setState({
      pages: { p1: { id: 'p1', name: 'Page 1', shapes: {}, shapeOrder: [], createdAt: 0, modifiedAt: 0 } },
      pageOrder: ['p1'],
      activePageId: 'p1',
    });
  });
  act(() => {
    useCollaborationStore.getState().startSession({
      serverUrl: 'ws://localhost:9876/ws',
      documentId: docId,
      // NO token → engine-only, `hasProvider` false. No `_setSynced(true)`:
      // offline, the relay never confirmed its state.
      user: { id: 'u', name: 'U', color: '#fff' },
    });
    useCollaborationStore.getState()._setIdbSynced(true);
  });
}

describe('useCollaborationSync', () => {
  beforeEach(() => {
    useDocumentStore.getState().clear();
    usePendingSyncPages.setState({ pending: {} });
    useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null });
    useCollaborationStore.setState({
      isActive: false,
      isSynced: false,
      isIdbSynced: false,
      config: null,
    });
  });

  afterEach(() => {
    if (useCollaborationStore.getState().isActive) {
      act(() => useCollaborationStore.getState().stopSession());
    }
    vi.clearAllMocks();
  });

  it('adopts the relay Y.Doc into the view (crdtShapes > 0)', () => {
    startSyncedSession();
    adoptShapes([shape('S1')]);

    renderHook(() => useCollaborationSync());

    expect(Object.keys(useDocumentStore.getState().shapes)).toContain('S1');
  });

  it('adopts to empty (never seeds) when the relay confirms an empty doc', () => {
    // Local view has a stale cached shape; the relay is empty.
    act(() => useDocumentStore.getState().addShape(shape('stale')));
    startSyncedSession();
    currentYjs.getAllShapes.mockReturnValue(new Map()); // relay empty

    renderHook(() => useCollaborationSync());

    // View cleared to match the authoritative-empty relay…
    expect(Object.keys(useDocumentStore.getState().shapes)).toHaveLength(0);
    // …and we NEVER seeded the shared Y.Doc (the clobber hazard, JP-179).
    expect(currentYjs.initializeFromState).not.toHaveBeenCalled();
  });

  it('does NOT propagate deletions caused by a document LOAD (#59)', () => {
    startSyncedSession();
    adoptShapes([shape('S1')]);
    renderHook(() => useCollaborationSync());
    expect(Object.keys(useDocumentStore.getState().shapes)).toContain('S1');
    currentYjs.deleteShape.mockClear();

    // A LOAD clears the store inside withAutoSaveSuppressed — must NOT broadcast.
    act(() => {
      withAutoSaveSuppressed(() => useDocumentStore.getState().clear());
    });
    expect(currentYjs.deleteShape).not.toHaveBeenCalled();
  });

  it('does NOT propagate a bare loadSnapshot — no suppression wrapper (JP-178)', () => {
    startSyncedSession();
    adoptShapes([shape('S1')]);
    renderHook(() => useCollaborationSync());
    expect(Object.keys(useDocumentStore.getState().shapes)).toContain('S1');
    currentYjs.deleteShape.mockClear();

    // A page-switch / undo / new-doc load that did NOT wrap in
    // withAutoSaveSuppressed: the store tags it 'replace', so the bridge must
    // still skip it (the structural fix that no longer relies on callers).
    act(() => {
      useDocumentStore.getState().loadSnapshot({ shapes: {}, shapeOrder: [], version: 1 });
    });
    expect(currentYjs.deleteShape).not.toHaveBeenCalled();
  });

  it('does NOT propagate a bare clear() — no suppression wrapper (JP-178)', () => {
    startSyncedSession();
    adoptShapes([shape('S1')]);
    renderHook(() => useCollaborationSync());
    currentYjs.deleteShape.mockClear();

    act(() => {
      useDocumentStore.getState().clear();
    });
    expect(currentYjs.deleteShape).not.toHaveBeenCalled();
  });

  it('DOES propagate a genuine user delete (control for #59)', () => {
    startSyncedSession();
    adoptShapes([shape('S1')]);
    renderHook(() => useCollaborationSync());
    currentYjs.deleteShape.mockClear();

    act(() => useDocumentStore.getState().deleteShape('S1'));
    expect(currentYjs.deleteShape).toHaveBeenCalledWith('S1');
  });

  it('propagates edits on any page — no off-page guard (JP-340)', () => {
    // JP-340 removed the JP-341 canvas page-guard: every page is its own
    // `shapes:<id>` surface, so an edit always lands on the bound page and
    // propagates. (The page binding is owned by `rebindActivePage`.)
    startSyncedSession();
    adoptShapes([shape('S1')]);
    renderHook(() => useCollaborationSync());
    currentYjs.setShape.mockClear();

    act(() => useDocumentStore.getState().addShape(shape('S2')));
    expect(currentYjs.setShape).toHaveBeenCalled();
  });

  it('adopts a prefetched Y.Doc OFFLINE so canvas is editable (JP-335)', () => {
    // The seeded room reports canvas content (`hasAnyShapes`), and we're offline
    // (no provider, not relay-synced). Before JP-335 this state fell into the
    // "offline + empty Y.Doc — defer" branch and canvas edits were dropped; with
    // a prefetched (non-empty) room the adopt runs and the bridge initializes.
    startOfflineSession();
    adoptShapes([shape('OFF1')]);

    renderHook(() => useCollaborationSync());

    // The seeded shapes loaded into the view…
    expect(Object.keys(useDocumentStore.getState().shapes)).toContain('OFF1');

    // …and the doc-store→CRDT bridge is live (`initializedRef` set), so an
    // offline edit is captured into the Y.Doc — not silently lost on reconnect.
    currentYjs.setShape.mockClear();
    act(() => useDocumentStore.getState().addShape(shape('OFF2')));
    expect(currentYjs.setShape).toHaveBeenCalled();
  });

  it('defers adopt when OFFLINE and the Y.Doc is empty (unprefetched — no dup risk)', () => {
    // Control for the above: a doc that was NOT prefetched has an empty room
    // offline, so adopt must still defer — pushing edits into a not-yet-adopted
    // Y.Doc would fork a fresh CRDT identity that duplicates on first sync.
    startOfflineSession('doc-empty');
    // hasAnyShapes stays false (default) and we never relay-sync.
    renderHook(() => useCollaborationSync());

    currentYjs.setShape.mockClear();
    act(() => useDocumentStore.getState().addShape(shape('X')));
    expect(currentYjs.setShape).not.toHaveBeenCalled();
  });

  it('hands off pending-sync pages on a synced session (JP-335)', () => {
    // A prose page + a (non-active) canvas page were created offline and marked
    // pending. On a live synced session the handoff must (re)emit their metas
    // into the CRDT, push the canvas page's committed shapes, and clear markers.
    act(() => {
      useRichTextPagesStore.setState({
        pages: {
          'rt-off': { id: 'rt-off', name: 'Offline notes', content: '<p>x</p>', order: 0, createdAt: 1, modifiedAt: 2 },
        },
        pageOrder: ['rt-off'],
        activePageId: 'rt-off',
      });
      usePendingSyncPages.getState().markPending('rt-off', 'doc-1');
      usePendingSyncPages.getState().markPending('cv-off', 'doc-1');
    });
    startSyncedSession('doc-1');
    // Add the pending canvas page (non-active; 'p1' stays active) with a shape.
    act(() => {
      usePageStore.setState((prev) => ({
        pages: {
          ...prev.pages,
          'cv-off': {
            id: 'cv-off', name: 'Offline canvas', createdAt: 1, modifiedAt: 2,
            shapes: { S9: shape('S9') }, shapeOrder: ['S9'],
          },
        },
        pageOrder: [...prev.pageOrder, 'cv-off'],
      }));
    });

    renderHook(() => useCollaborationSync());

    // Prose meta reached the CRDT page list.
    expect(currentYjs.setProsePage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rt-off', name: 'Offline notes' }),
    );
    // Canvas meta + the committed shapes reached the page's own surface.
    expect(currentYjs.setCanvasPage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cv-off', name: 'Offline canvas' }),
    );
    expect(currentYjs.seedPageShapes).toHaveBeenCalledWith(
      'cv-off',
      [expect.objectContaining({ id: 'S9' })],
      ['S9'],
    );
    // Markers cleared — the pages are ordinary synced pages from here on.
    expect(isPagePendingSync('rt-off')).toBe(false);
    expect(isPagePendingSync('cv-off')).toBe(false);
  });

  it('does NOT hand off while offline (no provider) — markers persist', () => {
    act(() => {
      usePendingSyncPages.getState().markPending('rt-off', 'doc-off');
    });
    // Engine-only offline session (no token → no provider, never synced).
    act(() => {
      usePageStore.setState({
        pages: { p1: { id: 'p1', name: 'Page 1', shapes: {}, shapeOrder: [], createdAt: 0, modifiedAt: 0 } },
        pageOrder: ['p1'],
        activePageId: 'p1',
      });
      useCollaborationStore.getState().startSession({
        serverUrl: 'ws://localhost:9876/ws',
        documentId: 'doc-off',
        user: { id: 'u', name: 'U', color: '#fff' },
      });
      useCollaborationStore.getState()._setIdbSynced(true);
    });

    renderHook(() => useCollaborationSync());

    expect(currentYjs.setProsePage).not.toHaveBeenCalled();
    expect(isPagePendingSync('rt-off')).toBe(true);
  });

  it('re-binds onShapeChange to the new Y.Doc after switchDocument (#60)', () => {
    startSyncedSession('doc-1');
    currentYjs.getAllShapes.mockReturnValue(new Map());
    renderHook(() => useCollaborationSync());
    const firstYjs = currentYjs;
    expect(firstYjs._shapeCbs.size).toBeGreaterThan(0);

    // Restart the session for another doc → brand-new YjsDocument instance.
    act(() => {
      useCollaborationStore.getState().switchDocument('doc-2');
      useCollaborationStore.getState()._setSynced(true);
      useCollaborationStore.getState()._setIdbSynced(true);
    });
    const secondYjs = currentYjs;
    expect(secondYjs).not.toBe(firstYjs);

    // Without the sessionEpoch fix the effect wouldn't re-run: callbacks would
    // stay on the old (destroyed) instance and the new one would have none.
    expect(firstYjs._shapeCbs.size).toBe(0);
    expect(secondYjs._shapeCbs.size).toBeGreaterThan(0);

    // A remote change on the NEW instance now reaches the view.
    act(() => {
      secondYjs._shapeCbs.forEach((cb) => cb([shape('R1')], [], []));
    });
    expect(Object.keys(useDocumentStore.getState().shapes)).toContain('R1');
  });
});
