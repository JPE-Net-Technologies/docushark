/**
 * Optional fields in a collaborative document, through the real path: a real
 * `YjsDocument` and `Y.UndoManager`, the real store and `useCollaborationSync`
 * bridge. Only the network is mocked.
 *
 * A shape in the Y.Doc is one whole value, so a field it no longer has is simply not
 * in it. The store has to lose that field too, or the next edit writes it back into
 * the document for everyone.
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
import { useCollaborationStore } from './collaborationStore';
import { useCollaborationSync } from './useCollaborationSync';
import { YjsDocument } from './YjsDocument';
import { useDocumentStore } from '../store/documentStore';
import { useHistoryStore } from '../store/historyStore';
import { usePageStore } from '../store/pageStore';
import { useRichTextPagesStore } from '../store/richTextPagesStore';

const PAGE = 'p1';

function rect(id: string, extra: object = {}): Shape {
  return {
    id,
    type: 'rectangle',
    x: 0,
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
    ...extra,
  } as unknown as Shape;
}

const store = () => useDocumentStore.getState();
const yjs = () => useCollaborationStore.getState().getYjsDocument()!;
const inStore = (id = 'a') => store().shapes[id] as unknown as Record<string, unknown>;
const inY = (id = 'a') => yjs().getShape(id) as unknown as Record<string, unknown>;
const undo = () => act(() => useHistoryStore.getState().undo());
const redo = () => act(() => useHistoryStore.getState().redo());

function edit(updates: object, id = 'a') {
  act(() => {
    useHistoryStore.getState().push('edit');
    store().updateShape(id, updates as Partial<Shape>);
  });
}

function openDocument(shapes: Shape[]) {
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
      documentId: 'doc-fields',
      token: 'test-token',
      user: { id: 'u', name: 'U', color: '#fff' },
    });
    const doc = useCollaborationStore.getState().getYjsDocument()!;
    doc.rebindActivePage(PAGE);
    doc.setShapes(shapes);
    doc.setShapeOrder(shapes.map((shape) => shape.id));
    useCollaborationStore.getState()._markSyncedHandshake();
    useCollaborationStore.getState()._setIdbSynced(true);
  });
  return renderHook(() => useCollaborationSync());
}

/** A second client: it writes whole shapes, and the relay delivers them here. */
function colleague() {
  const other = new YjsDocument();
  Y.applyUpdate(other.getDoc(), Y.encodeStateAsUpdate(yjs().getDoc()), 'relay');
  other.rebindActivePage(PAGE);
  return {
    doc: other,
    receive: () => Y.applyUpdate(other.getDoc(), Y.encodeStateAsUpdate(yjs().getDoc()), 'relay'),
    write: (shape: Shape) => {
      other.setShape(shape);
      act(() => Y.applyUpdate(yjs().getDoc(), Y.encodeStateAsUpdate(other.getDoc()), 'relay'));
    },
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

describe('a field a shape no longer has', () => {
  it('leaves the store when undo takes it away', () => {
    openDocument([rect('a')]);
    edit({ label: 'Added' });
    expect(inY()['label']).toBe('Added');
    undo();
    expect(inY()['label']).toBeUndefined();
    expect(inStore()['label']).toBeUndefined();
  });

  it('comes back with redo', () => {
    openDocument([rect('a')]);
    edit({ label: 'Added' });
    undo();
    redo();
    expect(inY()['label']).toBe('Added');
    expect(inStore()['label']).toBe('Added');
  });

  it('does not return to the document with your next edit', () => {
    openDocument([rect('a')]);
    edit({ label: 'Added' });
    undo();
    edit({ fill: '#123456' });
    expect(inY()['fill']).toBe('#123456');
    expect(inY()['label']).toBeUndefined();
  });

  it('leaves your store when a colleague clears it', () => {
    openDocument([rect('a', { label: 'Theirs' })]);
    const other = colleague();
    other.write(rect('a'));
    expect(inStore()['label']).toBeUndefined();
  });

  it('stays cleared for everyone after you edit next', () => {
    openDocument([rect('a', { label: 'Theirs' })]);
    const other = colleague();
    other.write(rect('a'));
    edit({ fill: '#123456' });
    other.receive();
    expect(other.doc.getShape('a')!.fill).toBe('#123456');
    expect((other.doc.getShape('a') as unknown as Record<string, unknown>)['label']).toBeUndefined();
  });
});

describe('the fields a shape keeps', () => {
  it('still follows a colleague', () => {
    openDocument([rect('a', { label: 'Mine' })]);
    const other = colleague();
    other.write(rect('a', { label: 'Theirs', fill: '#222' }));
    expect(inStore()['label']).toBe('Theirs');
    expect(inStore()['fill']).toBe('#222');
  });

  it('is untouched by a colleague editing another shape', () => {
    openDocument([rect('a', { label: 'Mine' }), rect('b')]);
    const before = store().shapes['a'];
    const other = colleague();
    other.write(rect('b', { fill: '#222' }));
    expect(store().shapes['a']).toBe(before);
  });
});
