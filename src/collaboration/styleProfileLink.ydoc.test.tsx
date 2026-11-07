/**
 * A style profile link in a collaborative document (DSK-224), through the real path:
 * a real `YjsDocument` and `Y.UndoManager`, the real store and `useCollaborationSync`
 * bridge, and the real panel. Only the network is mocked.
 *
 * The link is one optional field on a shape, and it has to travel, undo and survive
 * like any other. Clients from before it existed share these documents, so one that
 * has never heard of it mustn't lose it by editing the shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, renderHook, act, cleanup, screen, fireEvent } from '@testing-library/react';
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
import { useSessionStore } from '../store/sessionStore';
import { getProfileUpdates, useStyleProfileStore, type StyleProfile } from '../store/styleProfileStore';
import { PropertyPanel } from '../ui/PropertyPanel';

const PAGE = 'p1';

function rect(id: string): Shape {
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
    fill: '#123456',
    stroke: '#654321',
    strokeWidth: 3,
    cornerRadius: 1,
  } as unknown as Shape;
}

const green = (): StyleProfile =>
  useStyleProfileStore.getState().profiles.find((profile) => profile.name === 'Fresh Green')!;
const store = () => useDocumentStore.getState();
const yjs = () => useCollaborationStore.getState().getYjsDocument()!;
const inStore = (id = 'a') => store().shapes[id]!;
const inY = (id = 'a') => yjs().getAllShapes().get(id)!;
const undo = () => act(() => useHistoryStore.getState().undo());
const redo = () => act(() => useHistoryStore.getState().redo());

/** Applying a profile as the panel does: the history funnel, then the store. */
function apply(id = 'a') {
  act(() => {
    useHistoryStore.getState().push('Apply style profile');
    store().updateShape(id, { ...getProfileUpdates(green(), inStore(id)), styleProfileId: green().id } as Partial<Shape>);
  });
}

function edit(updates: Partial<Shape>, id = 'a') {
  act(() => {
    useHistoryStore.getState().push('edit');
    store().updateShape(id, updates);
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
      documentId: 'doc-link',
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

/** A second client on the same document, as the relay would connect it. */
function peer() {
  const other = new YjsDocument();
  Y.applyUpdate(other.getDoc(), Y.encodeStateAsUpdate(yjs().getDoc()), 'relay');
  other.rebindActivePage(PAGE);
  return {
    doc: other,
    receive: () => Y.applyUpdate(other.getDoc(), Y.encodeStateAsUpdate(yjs().getDoc()), 'relay'),
    /** As any client edits: merged into the whole shape it holds, known fields or not. */
    edit: (updates: object, id = 'a') => {
      other.setShape({ ...other.getShape(id)!, ...updates } as Shape);
      act(() => Y.applyUpdate(yjs().getDoc(), Y.encodeStateAsUpdate(other.getDoc()), 'relay'));
    },
  };
}

beforeEach(() => {
  act(() => {
    useCollaborationStore.getState().stopSession?.();
    useDocumentStore.getState().clear();
    useSessionStore.getState().clearSelection();
  });
});

afterEach(() => {
  cleanup();
  act(() => {
    useCollaborationStore.getState().stopSession?.();
  });
});

describe('a style profile link in a collaborative document', () => {
  it('is written with the look, and reaches a colleague', () => {
    openDocument([rect('a')]);
    const colleague = peer();
    apply();
    expect(inY().styleProfileId).toBe(green().id);
    expect(inY().fill).toBe(green().properties.fill);
    colleague.receive();
    const theirs = colleague.doc.getShape('a')!;
    expect(theirs.styleProfileId).toBe(green().id);
    expect(theirs.fill).toBe(green().properties.fill);
  });

  it('undoes with the look, and redoes with it', () => {
    openDocument([rect('a')]);
    apply();
    undo();
    expect(inStore().styleProfileId).toBeUndefined();
    expect(inY().styleProfileId).toBeUndefined();
    expect(inStore().fill).toBe('#123456');
    expect(inY().fill).toBe('#123456');
    redo();
    expect(inStore().styleProfileId).toBe(green().id);
    expect(inY().styleProfileId).toBe(green().id);
    expect(inY().fill).toBe(green().properties.fill);
  });

  it('survives a client that has never heard of it editing the shape', () => {
    openDocument([rect('a')]);
    apply();
    const older = peer();
    older.edit({ fill: '#000009' });
    expect(inStore().fill).toBe('#000009');
    expect(inStore().styleProfileId).toBe(green().id);
    expect(inY().styleProfileId).toBe(green().id);
  });

  it('follows the document when a colleague reapplies, and shows up as no change', () => {
    openDocument([rect('a')]);
    const colleague = peer();
    act(() => useSessionStore.getState().select(['a']));
    render(<PropertyPanel />);
    colleague.edit({ ...getProfileUpdates(green(), inStore()), styleProfileId: green().id });
    expect(document.querySelector('.style-row-name')?.textContent).toBe('Fresh Green');
    expect(document.querySelector('.style-row-changes')).toBeNull();
  });

  it('means nothing to a client without that profile, which keeps it for those who have it', () => {
    openDocument([rect('a')]);
    const colleague = peer();
    colleague.edit({ styleProfileId: 'their-own' });
    act(() => useSessionStore.getState().select(['a']));
    render(<PropertyPanel />);
    expect(document.querySelector('.style-row-name')?.textContent).toBe('Custom');
    edit({ fill: '#000002' });
    expect(inY().styleProfileId).toBe('their-own');
  });

  it('counts a change a colleague made, and resets it from the panel, undoably', () => {
    openDocument([rect('a')]);
    apply();
    const colleague = peer();
    act(() => useSessionStore.getState().select(['a']));
    render(<PropertyPanel />);
    colleague.edit({ fill: '#000009' });
    expect(document.querySelector('.style-row-changes')?.textContent).toBe('1 change');

    fireEvent.click(screen.getByRole('button', { name: 'Reset fill to Fresh Green' }));
    expect(inY().fill).toBe(green().properties.fill);
    expect(inY().styleProfileId).toBe(green().id);
    expect(document.querySelector('.style-row-changes')).toBeNull();

    undo();
    expect(inY().fill).toBe('#000009');
    expect(document.querySelector('.style-row-changes')?.textContent).toBe('1 change');
  });

  it('resets everything from the row as one undo step', () => {
    openDocument([rect('a')]);
    apply();
    edit({ fill: '#000001', strokeWidth: 99 });
    act(() => useSessionStore.getState().select(['a']));
    render(<PropertyPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset all to Fresh Green' }));
    expect(inY().fill).toBe(green().properties.fill);
    expect(inY().strokeWidth).toBe(green().properties.strokeWidth);
    undo();
    expect(inY().fill).toBe('#000001');
    expect(inY().strokeWidth).toBe(99);
    expect(inY().styleProfileId).toBe(green().id);
    redo();
    expect(inY().fill).toBe(green().properties.fill);
  });
});
