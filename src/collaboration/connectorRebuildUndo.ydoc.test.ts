/**
 * DSK-12: undoing "Rebuild all connector routes" in a collaborative document,
 * through the real path: a real `YjsDocument` and its per-page `Y.UndoManager`,
 * the real document store, and the real `useCollaborationSync` bridge. Only the
 * network is mocked (the harness is DSK-221's, `groupUndo.ydoc.test.ts`).
 *
 * Reported on the local stack: after a rebuild and an undo, the relay's copy had
 * lost one connector while the editor still showed it, and the relay persisted
 * the loss. Every loss came in a session with earlier rebuild, undo and page-switch
 * history. The invariant checked after every step here: the shared copy holds
 * exactly the shapes the store holds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import * as Y from 'yjs';
import type { Shape } from '../shapes/Shape';

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
vi.mock('../store/persistenceStore', () => ({ applyRemoteDocumentName: vi.fn() }));

import '../shapes/Rectangle';
import '../shapes/Connector';
import { useCollaborationStore } from './collaborationStore';
import { useCollaborationSync } from './useCollaborationSync';
import { YjsDocument } from './YjsDocument';
import { rebuildConnectorRoutes } from '../engine/selectionLayout';
import { useDocumentStore } from '../store/documentStore';
import { useHistoryStore } from '../store/historyStore';
import { usePageStore } from '../store/pageStore';
import { useRichTextPagesStore } from '../store/richTextPagesStore';

const PAGE = 'p1';
const OTHER = 'p2';

function rect(id: string, x: number, y: number): Shape {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: 80,
    height: 40,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#fff',
    stroke: '#000',
    strokeWidth: 1,
    cornerRadius: 0,
  } as unknown as Shape;
}

function connector(id: string, from: string, to: string, startAnchor: string, endAnchor: string): Shape {
  return {
    id,
    type: 'connector',
    x: 0,
    y: 0,
    x2: 0,
    y2: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: null,
    stroke: '#000',
    strokeWidth: 1,
    startShapeId: from,
    endShapeId: to,
    startAnchor,
    endAnchor,
    startArrow: false,
    endArrow: true,
    routingMode: 'orthogonal',
    waypoints: [],
  } as unknown as Shape;
}

/**
 * 100 nodes on a grid and 141 connectors between neighbours, like the issue's
 * generated 100-node page, already routed. Then every seventh node moves, so its
 * connectors go stale and the rebuild re-routes a subset of them, as in the
 * issue (10 of 141), rather than all or none.
 */
function diagram(prefix = ''): Shape[] {
  const store = useDocumentStore.getState();
  store.clear();
  store.addShapes(gridDiagram(prefix));
  store.rebuildAllConnectorRoutes();
  const routed = JSON.parse(JSON.stringify(Object.values(useDocumentStore.getState().shapes))) as Shape[];
  store.clear();
  for (const shape of routed) {
    const match = /n-(\d+)-(\d+)$/.exec(shape.id);
    if (match && (Number(match[1]) * 10 + Number(match[2])) % 7 === 0) shape.y += 45;
  }
  return routed;
}

function gridDiagram(prefix: string): Shape[] {
  const shapes: Shape[] = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      shapes.push(rect(`${prefix}n-${r}-${c}`, c * 160, r * 120));
    }
  }
  let k = 0;
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      shapes.push(connector(`${prefix}e${k++}`, `${prefix}n-${r}-${c}`, `${prefix}n-${r}-${c + 1}`, 'right', 'left'));
    }
  }
  for (let r = 0; r < 9 && k < 141; r++) {
    for (let c = 0; c < 10 && k < 141; c++) {
      shapes.push(connector(`${prefix}e${k++}`, `${prefix}n-${r}-${c}`, `${prefix}n-${r + 1}-${c}`, 'bottom', 'top'));
    }
  }
  return shapes;
}

const store = () => useDocumentStore.getState();
const yjs = () => useCollaborationStore.getState().getYjsDocument()!;
const yShapeIds = () => [...yjs().getAllShapes().keys()].sort();
const storeShapeIds = () => Object.keys(store().shapes).sort();
const yConnectors = () => [...yjs().getAllShapes().values()].filter((s) => s.type === 'connector').length;

/** Every connector in the shared copy, by id, as JSON. */
function sharedConnectors(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, shape] of yjs().getAllShapes()) {
    if (shape.type === 'connector') out.set(id, JSON.stringify(shape));
  }
  return out;
}
/** The connectors whose shared data differs between two readings. */
function changedConnectors(a: Map<string, string>, b: Map<string, string>): string[] {
  return [...a.keys()].filter((id) => a.get(id) !== b.get(id));
}

/** The shared copy holds exactly the store's shapes, and both hold every connector. */
function expectWhole(step: string, connectors = 141) {
  const missingFromShared = storeShapeIds().filter((id) => !yjs().getAllShapes().has(id));
  const missingFromStore = yShapeIds().filter((id) => !(id in store().shapes));
  expect({ step, missingFromShared, missingFromStore, sharedConnectors: yConnectors() }).toEqual({
    step,
    missingFromShared: [],
    missingFromStore: [],
    sharedConnectors: connectors,
  });
}

/** A user action as the app runs it: the history funnel, then the store. */
function edit(action: () => void) {
  act(() => {
    useHistoryStore.getState().push('edit');
    action();
  });
}
const undo = () => act(() => useHistoryStore.getState().undo());
const redo = () => act(() => useHistoryStore.getState().redo());
const rebuild = () => edit(() => store().rebuildAllConnectorRoutes());
const switchTo = (pageId: string) => act(() => usePageStore.setState({ activePageId: pageId }));

/** Open a two-page document whose Y.Doc holds `diagram()` on each page, and adopt it. */
function openDocument() {
  const main = diagram();
  const other = diagram('o-');
  act(() => {
    usePageStore.setState({
      pages: {
        [PAGE]: { id: PAGE, name: 'Page 1', shapes: {}, shapeOrder: [], createdAt: 0, modifiedAt: 0 },
        [OTHER]: { id: OTHER, name: 'Page 2', shapes: {}, shapeOrder: [], createdAt: 0, modifiedAt: 0 },
      },
      pageOrder: [PAGE, OTHER],
      activePageId: PAGE,
    });
    useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null } as never);
  });
  act(() => {
    useCollaborationStore.getState().startSession({
      serverUrl: 'ws://localhost:9876/ws',
      documentId: 'doc-dsk12',
      token: 'test-token',
      user: { id: 'u', name: 'U', color: '#fff' },
    });
    const doc = useCollaborationStore.getState().getYjsDocument()!;
    doc.rebindActivePage(OTHER);
    doc.setShapes(other);
    doc.setShapeOrder(other.map((s) => s.id));
    doc.rebindActivePage(PAGE);
    doc.setShapes(main);
    doc.setShapeOrder(main.map((s) => s.id));
    useCollaborationStore.getState()._markSyncedHandshake();
    useCollaborationStore.getState()._setIdbSynced(true);
  });
  return renderHook(() => useCollaborationSync());
}

beforeEach(() => {
  act(() => {
    useCollaborationStore.getState().stopSession?.();
    useDocumentStore.getState().clear();
  });
});

afterEach(() => {
  cleanup();
  act(() => {
    useCollaborationStore.getState().stopSession?.();
  });
});

/**
 * The relay as a second replica with its own client id. It hydrates the page,
 * so every item the editor adopts is relay-owned, as in production. Updates
 * flow both ways after every step, the way the provider and the relay relay
 * them.
 */
function openFromRelay() {
  const relay = new YjsDocument();
  const main = diagram();
  relay.rebindActivePage(PAGE);
  relay.setShapes(main);
  relay.setShapeOrder(main.map((s) => s.id));
  act(() => {
    usePageStore.setState({
      pages: { [PAGE]: { id: PAGE, name: 'Page 1', shapes: {}, shapeOrder: [], createdAt: 0, modifiedAt: 0 } },
      pageOrder: [PAGE],
      activePageId: PAGE,
    });
    useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null } as never);
  });
  act(() => {
    useCollaborationStore.getState().startSession({
      serverUrl: 'ws://localhost:9876/ws',
      documentId: 'doc-dsk12-relay',
      token: 'test-token',
      user: { id: 'u', name: 'U', color: '#fff' },
    });
    const doc = useCollaborationStore.getState().getYjsDocument()!;
    Y.applyUpdate(doc.getDoc(), Y.encodeStateAsUpdate(relay.getDoc()), 'relay');
    doc.rebindActivePage(PAGE);
    useCollaborationStore.getState()._markSyncedHandshake();
    useCollaborationStore.getState()._setIdbSynced(true);
  });
  renderHook(() => useCollaborationSync());
  const exchange = () =>
    act(() => {
      const client = yjs().getDoc();
      Y.applyUpdate(relay.getDoc(), Y.encodeStateAsUpdate(client, Y.encodeStateVector(relay.getDoc())), 'client');
      Y.applyUpdate(client, Y.encodeStateAsUpdate(relay.getDoc(), Y.encodeStateVector(client)), 'relay');
    });
  const relayIds = () => [...relay.getAllShapes().keys()].sort();
  return { relay, exchange, relayIds };
}

describe('undoing "Rebuild all connector routes" in a collaborative document (DSK-12)', () => {
  it('runs the toolbar’s rebuild as its own undo step, even right after an edit', () => {
    // The toolbar used to call the store action with no history step, so in a
    // collaborative document the rebuild's writes joined the open undo step: an
    // edit made within the capture window was undone along with the rebuild.
    openDocument();
    const moved = store().shapes['n-0-1']!.y + 60;
    edit(() => store().updateShape('n-0-1', { y: moved } as Partial<Shape>));
    act(() => rebuildConnectorRoutes());
    undo();
    expect(store().shapes['n-0-1']!.y).toBe(moved);
    expect((yjs().getAllShapes().get('n-0-1') as Shape).y).toBe(moved);
    expectWhole('after undoing the rebuild');
  });

  it('keeps the relay’s copy whole when the relay owns the items (a relay peer)', () => {
    const { exchange, relayIds } = openFromRelay();
    for (let round = 1; round <= 4; round++) {
      rebuild();
      exchange();
      expect(relayIds(), `round ${round}: relay after the rebuild`).toEqual(storeShapeIds());
      undo();
      exchange();
      expect(relayIds(), `round ${round}: relay after the undo`).toEqual(storeShapeIds());
      expectWhole(`round ${round}: editor after the undo`);
      redo();
      exchange();
      expect(relayIds(), `round ${round}: relay after the redo`).toEqual(storeShapeIds());
    }
  });

  it('adopts the diagram whole', () => {
    openDocument();
    expectWhole('adopted');
  });

  it('keeps every connector through one rebuild and its undo', () => {
    openDocument();
    const before = sharedConnectors();
    rebuild();
    expectWhole('after the rebuild');
    // The rebuild re-routed a subset of the connectors in the shared copy, so
    // the undo below has real work to do.
    const changed = changedConnectors(before, sharedConnectors());
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThan(141);
    expect(useCollaborationStore.getState().canUndoCanvas).toBe(true);
    undo();
    expectWhole('after the undo');
    // The undo restored every re-routed connector exactly.
    expect(changedConnectors(before, sharedConnectors())).toEqual([]);
  });

  it('keeps every connector through repeated rebuilds, undos and redos', () => {
    openDocument();
    for (let round = 1; round <= 4; round++) {
      rebuild();
      expectWhole(`round ${round}: rebuild`);
      undo();
      expectWhole(`round ${round}: undo`);
      redo();
      expectWhole(`round ${round}: redo`);
      undo();
      expectWhole(`round ${round}: undo again`);
    }
  });

  it('keeps every connector when page switches come between rebuilds and undos', () => {
    openDocument();
    for (let round = 1; round <= 4; round++) {
      rebuild();
      expectWhole(`round ${round}: rebuild`);
      switchTo(OTHER);
      switchTo(PAGE);
      expectWhole(`round ${round}: back on the page`);
      undo();
      expectWhole(`round ${round}: undo after the switch`);
      rebuild();
      undo();
      expectWhole(`round ${round}: rebuild and undo`);
    }
  });
});
