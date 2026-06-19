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
    getName: vi.fn(() => undefined),
    setShape: vi.fn(),
    setShapes: vi.fn(),
    deleteShape: vi.fn(),
    setShapeOrder: vi.fn(),
    setMetadata: vi.fn(),
    clear: vi.fn(),
    destroy: vi.fn(),
    initializeFromState: vi.fn(),
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
vi.mock('../store/connectionStore', () => ({
  useConnectionStore: {
    getState: () => ({
      setHost: vi.fn(),
      reset: vi.fn(),
      setToken: vi.fn(),
      token: null,
      tokenExpiresAt: null,
    }),
    subscribe: () => () => {},
  },
  startTokenExpirationMonitor: vi.fn(),
  stopTokenExpirationMonitor: vi.fn(),
  muteConnectionToasts: vi.fn(),
}));
vi.mock('../store/presenceStore', () => ({
  usePresenceStore: {
    getState: () => ({ setLocalUser: vi.fn(), clearRemoteUsers: vi.fn(), syncRemoteUsers: vi.fn() }),
  },
}));
// Avoid the heavy persistenceStore import chain; the name-apply is irrelevant here.
vi.mock('../store/persistenceStore', () => ({ applyRemoteDocumentName: vi.fn() }));

import { useCollaborationStore } from './collaborationStore';
import { useDocumentStore } from '../store/documentStore';
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

describe('useCollaborationSync', () => {
  beforeEach(() => {
    useDocumentStore.getState().clear();
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
    currentYjs.getAllShapes.mockReturnValue(new Map([['S1', shape('S1')]]));

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
    currentYjs.getAllShapes.mockReturnValue(new Map([['S1', shape('S1')]]));
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
    currentYjs.getAllShapes.mockReturnValue(new Map([['S1', shape('S1')]]));
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
    currentYjs.getAllShapes.mockReturnValue(new Map([['S1', shape('S1')]]));
    renderHook(() => useCollaborationSync());
    currentYjs.deleteShape.mockClear();

    act(() => {
      useDocumentStore.getState().clear();
    });
    expect(currentYjs.deleteShape).not.toHaveBeenCalled();
  });

  it('DOES propagate a genuine user delete (control for #59)', () => {
    startSyncedSession();
    currentYjs.getAllShapes.mockReturnValue(new Map([['S1', shape('S1')]]));
    renderHook(() => useCollaborationSync());
    currentYjs.deleteShape.mockClear();

    act(() => useDocumentStore.getState().deleteShape('S1'));
    expect(currentYjs.deleteShape).toHaveBeenCalledWith('S1');
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
