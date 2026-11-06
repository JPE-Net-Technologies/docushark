/**
 * Groups in a collaborative document, through the real path (DSK-221): a real
 * `YjsDocument` and `Y.UndoManager`, the real document store, and the real
 * `useCollaborationSync` bridge between them. Only the network is mocked.
 *
 * A shape is drawn if it is in `shapeOrder` or in a group's `childIds`. In
 * neither it has vanished (an orphan); in both it is drawn twice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import * as Y from 'yjs';
import type { GroupShape, Shape } from '../shapes/Shape';

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
import '../shapes/Group';
import { useCollaborationStore } from './collaborationStore';
import { useCollaborationSync } from './useCollaborationSync';
import { YjsDocument } from './YjsDocument';
import { useDocumentStore } from '../store/documentStore';
import { useHistoryStore } from '../store/historyStore';
import { usePageStore } from '../store/pageStore';
import { useRichTextPagesStore } from '../store/richTextPagesStore';

const PAGE = 'p1';

function rect(id: string, x = 0): Shape {
  return {
    id,
    type: 'rectangle',
    x,
    y: 0,
    width: 10,
    height: 10,
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

function group(id: string, childIds: string[]): Shape {
  return {
    id,
    type: 'group',
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: null,
    stroke: null,
    strokeWidth: 0,
    childIds,
  } as unknown as Shape;
}

const store = () => useDocumentStore.getState();
const yjs = () => useCollaborationStore.getState().getYjsDocument()!;
const yOrder = () => yjs().getShapeOrder();
const yShapeIds = () => [...yjs().getAllShapes().keys()].sort();

/** Shapes nothing draws: in no group and not in the order. */
function orphans(): string[] {
  const { shapes, shapeOrder } = store();
  const children = new Set(Object.values(shapes).flatMap((s) => ('childIds' in s ? (s.childIds as string[]) : [])));
  return Object.keys(shapes).filter((id) => !shapeOrder.includes(id) && !children.has(id));
}

/** Shapes drawn twice: in the order and in a group. */
function drawnTwice(): string[] {
  const { shapes, shapeOrder } = store();
  const children = new Set(Object.values(shapes).flatMap((s) => ('childIds' in s ? (s.childIds as string[]) : [])));
  return shapeOrder.filter((id) => children.has(id));
}

/** The store and the Y.Doc agree, and nothing is lost or drawn twice. */
function expectSound(order: string[]) {
  expect(yOrder(), 'the Y.Doc order').toEqual(order);
  expect(store().shapeOrder, 'the store order').toEqual(order);
  expect(orphans(), 'shapes nothing draws').toEqual([]);
  expect(drawnTwice(), 'shapes drawn twice').toEqual([]);
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

/** Open a document whose Y.Doc holds `shapes`, in `order`, and adopt it. */
function openDocument(shapes: Shape[], order: string[]) {
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
      documentId: 'doc-group',
      token: 'test-token',
      user: { id: 'u', name: 'U', color: '#fff' },
    });
    const doc = useCollaborationStore.getState().getYjsDocument()!;
    doc.rebindActivePage(PAGE);
    doc.setShapes(shapes);
    doc.setShapeOrder(order);
    useCollaborationStore.getState()._markSyncedHandshake();
    useCollaborationStore.getState()._setIdbSynced(true);
  });
  return renderHook(() => useCollaborationSync());
}

/**
 * A second client on the same document: whatever it writes reaches this client
 * as a remote update, as the relay would deliver it.
 */
function peer() {
  const other = new YjsDocument();
  Y.applyUpdate(other.getDoc(), Y.encodeStateAsUpdate(yjs().getDoc()), 'relay');
  other.rebindActivePage(PAGE);
  return {
    doc: other,
    deliver: () => act(() => Y.applyUpdate(yjs().getDoc(), Y.encodeStateAsUpdate(other.getDoc()), 'relay')),
  };
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

const BASE = ['a', 'b', 'c', 'd'];
const baseShapes = () => BASE.map((id, index) => rect(id, index * 20));

describe('grouping in a collaborative document', () => {
  it('adopts a document with no groups', () => {
    openDocument(baseShapes(), BASE);
    expectSound(BASE);
  });

  it('groups in both the store and the Y.Doc', () => {
    openDocument(baseShapes(), BASE);
    edit(() => store().groupShapes(['b', 'c'], 'g'));
    expectSound(['a', 'g', 'd']);
  });

  it('undoes a group: the children come back, in their old places', () => {
    openDocument(baseShapes(), BASE);
    edit(() => store().groupShapes(['b', 'c'], 'g'));
    undo();
    expect(store().shapes['g']).toBeUndefined();
    expect(yShapeIds()).toEqual(BASE);
    expectSound(BASE);
  });

  it('redoes a group', () => {
    openDocument(baseShapes(), BASE);
    edit(() => store().groupShapes(['b', 'c'], 'g'));
    undo();
    redo();
    expect(store().shapes['g']).toBeDefined();
    expectSound(['a', 'g', 'd']);
  });

  it('undoes an ungroup: the group comes back, with its children inside', () => {
    openDocument([...baseShapes(), group('g', ['b', 'c'])], ['a', 'g', 'd']);
    edit(() => store().ungroupShape('g'));
    expectSound(BASE);
    undo();
    expect(store().shapes['g']).toBeDefined();
    expectSound(['a', 'g', 'd']);
  });

  it('redoes an ungroup', () => {
    openDocument([...baseShapes(), group('g', ['b', 'c'])], ['a', 'g', 'd']);
    edit(() => store().ungroupShape('g'));
    undo();
    redo();
    expect(store().shapes['g']).toBeUndefined();
    expectSound(BASE);
  });

  it('undoes an ungroup of a group edited since its last reorder', () => {
    // The group's map entry is newer than the order array's, so undo restores
    // the order first: the order then names a group the store doesn't have yet.
    openDocument([...baseShapes(), group('g', ['b', 'c'])], ['a', 'g', 'd']);
    edit(() => store().updateShape('g', { x: 50 } as Partial<Shape>));
    edit(() => store().ungroupShape('g'));
    undo();
    expect(store().shapes['g']).toBeDefined();
    expectSound(['a', 'g', 'd']);
  });

  it('undoes a delete of a whole group', () => {
    openDocument([...baseShapes(), group('g', ['b', 'c'])], ['a', 'g', 'd']);
    edit(() => store().deleteShapes(['g', 'b', 'c']));
    expectSound(['a', 'd']);
    undo();
    expect(store().shapes['g']).toBeDefined();
    expect(store().shapes['b']).toBeDefined();
    expectSound(['a', 'g', 'd']);
  });

  it('undoes moving a shape into a group', () => {
    openDocument([...baseShapes(), group('g', ['b', 'c'])], ['a', 'g', 'd']);
    edit(() => store().moveShapeInHierarchy('a', 'g'));
    expectSound(['g', 'd']);
    undo();
    expect((store().shapes['g'] as GroupShape).childIds).toEqual(['b', 'c']);
    expectSound(['a', 'g', 'd']);
    redo();
    expectSound(['g', 'd']);
  });

  it('undoes moving a shape into a group edited since its last reorder', () => {
    // As above with the ungroup: the order comes back before the group does.
    openDocument([...baseShapes(), group('g', ['b', 'c'])], ['a', 'g', 'd']);
    edit(() => store().updateShape('g', { x: 50 } as Partial<Shape>));
    edit(() => store().moveShapeInHierarchy('a', 'g'));
    undo();
    expect((store().shapes['g'] as GroupShape).childIds).toEqual(['b', 'c']);
    expectSound(['a', 'g', 'd']);
  });

  it('undoes moving a shape out of a group', () => {
    openDocument([...baseShapes(), group('g', ['b', 'c'])], ['a', 'g', 'd']);
    edit(() => store().moveShapeInHierarchy('b', null));
    expect(store().shapeOrder).toContain('b');
    expect(orphans()).toEqual([]);
    expect(drawnTwice()).toEqual([]);
    undo();
    expect((store().shapes['g'] as GroupShape).childIds).toEqual(['b', 'c']);
    expectSound(['a', 'g', 'd']);
  });

  it('undoes pasting a group', () => {
    openDocument(baseShapes(), BASE);
    edit(() => store().addPastedShapes([rect('b2'), rect('c2'), group('g2', ['b2', 'c2'])], ['g2']));
    expectSound([...BASE, 'g2']);
    undo();
    expect(store().shapes['b2']).toBeUndefined();
    expect(yShapeIds()).toEqual(BASE);
    expectSound(BASE);
  });

  it('undoes an ungroup of a nested group', () => {
    const shapes = [...baseShapes(), group('inner', ['a', 'b']), group('outer', ['inner', 'c'])];
    openDocument(shapes, ['outer', 'd']);
    expectSound(['outer', 'd']);
    edit(() => store().ungroupShape('inner'));
    expect((store().shapes['outer'] as GroupShape).childIds).toEqual(['a', 'b', 'c']);
    expectSound(['outer', 'd']);
    undo();
    expect((store().shapes['outer'] as GroupShape).childIds).toEqual(['inner', 'c']);
    expect(store().shapes['inner']).toBeDefined();
    expectSound(['outer', 'd']);
  });

  it('keeps editing sound after undoing a group', () => {
    openDocument(baseShapes(), BASE);
    edit(() => store().groupShapes(['b', 'c'], 'g'));
    undo();
    // The next local order change is written back whole: an order that had lost
    // the children would now lose them from the shared document too.
    edit(() => store().addShape(rect('e', 200)));
    expectSound([...BASE, 'e']);
  });
});

describe('a document opened with groups', () => {
  it('keeps the children out of the order, without complaint', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    openDocument([...baseShapes(), group('g', ['b', 'c'])], ['a', 'g', 'd']);
    expectSound(['a', 'g', 'd']);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('heals an order an earlier version wrote with the children in it', () => {
    openDocument([...baseShapes(), group('g', ['b', 'c'])], ['a', 'b', 'c', 'd', 'g', 'b', 'c']);
    expect(store().shapeOrder).toEqual(['a', 'd', 'g']);
    expect(orphans()).toEqual([]);
    expect(drawnTwice()).toEqual([]);
    // Loading never writes to the shared document.
    expect(yOrder()).toEqual(['a', 'b', 'c', 'd', 'g', 'b', 'c']);
    // The next edit to the order takes the healed one back.
    edit(() => store().addShape(rect('e', 200)));
    expectSound(['a', 'd', 'g', 'e']);
  });

  it('keeps the saved z-order', () => {
    const ids = ['d', 'g', 'a'];
    openDocument([...baseShapes(), group('g', ['b', 'c'])], ids);
    expectSound(ids);
  });
});

describe('a peer changing groups', () => {
  it('shows a group a peer made', () => {
    openDocument(baseShapes(), BASE);
    const other = peer();
    other.doc.setShape(group('g', ['b', 'c']));
    other.doc.setShapeOrder(['a', 'g', 'd']);
    other.deliver();
    expectSound(['a', 'g', 'd']);
  });

  it('shows a group a peer made, delivered in two steps', () => {
    openDocument(baseShapes(), BASE);
    const other = peer();
    other.doc.setShape(group('g', ['b', 'c']));
    other.deliver();
    other.doc.setShapeOrder(['a', 'g', 'd']);
    other.deliver();
    expectSound(['a', 'g', 'd']);
  });

  it('shows a peer ungrouping', () => {
    openDocument([...baseShapes(), group('g', ['b', 'c'])], ['a', 'g', 'd']);
    const other = peer();
    other.doc.deleteShape('g');
    other.doc.setShapeOrder(BASE);
    other.deliver();
    expect(store().shapes['g']).toBeUndefined();
    expectSound(BASE);
  });
});

describe('shapes nothing draws', () => {
  it('stays drawn when an order arrives without a top-level shape', () => {
    openDocument(baseShapes(), BASE);
    const other = peer();
    other.doc.setShapeOrder(['d', 'c', 'b']);
    other.deliver();
    expect(store().shapeOrder).toEqual(['d', 'c', 'b', 'a']);
    expect(orphans()).toEqual([]);
  });

  it('draws a shape the document left out of everything, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    openDocument(baseShapes(), ['a', 'b', 'c']);
    expect(store().shapeOrder).toEqual(['a', 'b', 'c', 'd']);
    expect(orphans()).toEqual([]);
    expect(warn.mock.calls.some(([message, ids]) => String(message).includes(PAGE) && JSON.stringify(ids) === '["d"]')).toBe(true);
    // Loading never writes to the shared document.
    expect(yOrder()).toEqual(['a', 'b', 'c']);
    warn.mockRestore();
  });
});
