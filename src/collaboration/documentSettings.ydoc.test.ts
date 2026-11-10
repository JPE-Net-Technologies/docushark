/**
 * Document settings in a collaborative document, through the real path
 * (DSK-246): a real `YjsDocument`, the real settings store, and the real
 * `useCollaborationSync` bridge between them. Only the network is mocked.
 *
 * Settings merge per key, and every key travels, known to this build or not.
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
vi.mock('../store/persistenceStore', () => ({ applyRemoteDocumentName: vi.fn(), applyRemoteDocumentTags: vi.fn() }));

import '../shapes/Rectangle';
import { useCollaborationStore } from './collaborationStore';
import { useCollaborationSync } from './useCollaborationSync';
import { YjsDocument } from './YjsDocument';
import { useDocumentStore } from '../store/documentStore';
import { useDocumentSettingsStore } from '../store/documentSettingsStore';
import { usePageStore } from '../store/pageStore';
import { useRichTextPagesStore } from '../store/richTextPagesStore';

const PAGE = 'p1';

const rect = { id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, rotation: 0, opacity: 1,
  locked: false, visible: true, fill: '#fff', stroke: '#000', strokeWidth: 1, cornerRadius: 0 } as unknown as Shape;

const yjs = () => useCollaborationStore.getState().getYjsDocument()!;
const settings = () => useDocumentSettingsStore.getState().settings;

/**
 * Open a document whose Y.Doc holds `initial` settings, and adopt it: one with
 * shapes, or one without (the relay confirmed it holds none).
 */
function openDocument(initial: Record<string, unknown>, { withShapes = true } = {}) {
  act(() => {
    usePageStore.setState({
      pages: { [PAGE]: { id: PAGE, name: 'Page 1', shapes: {}, shapeOrder: [], createdAt: 0, modifiedAt: 0 } },
      pageOrder: [PAGE],
      activePageId: PAGE,
    });
    useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null } as never);
    useDocumentSettingsStore.getState().load({ stale: 'from the cached copy' }, 'doc-settings');
  });
  act(() => {
    useCollaborationStore.getState().startSession({
      serverUrl: 'ws://localhost:9876/ws',
      documentId: 'doc-settings',
      token: 'test-token',
      user: { id: 'u', name: 'U', color: '#fff' },
    });
    const doc = useCollaborationStore.getState().getYjsDocument()!;
    doc.rebindActivePage(PAGE);
    if (withShapes) {
      doc.setShapes([rect]);
      doc.setShapeOrder(['a']);
    }
    for (const [key, value] of Object.entries(initial)) doc.setSetting(key, value);
    useCollaborationStore.getState()._markSyncedHandshake();
    useCollaborationStore.getState()._setIdbSynced(true);
  });
  return renderHook(() => useCollaborationSync());
}

/** A second client: what it writes reaches this one as the relay would deliver it. */
function peer() {
  const other = new YjsDocument();
  Y.applyUpdate(other.getDoc(), Y.encodeStateAsUpdate(yjs().getDoc()), 'relay');
  return {
    doc: other,
    deliver: () => act(() => Y.applyUpdate(yjs().getDoc(), Y.encodeStateAsUpdate(other.getDoc()), 'relay')),
    receive: () => Y.applyUpdate(other.getDoc(), Y.encodeStateAsUpdate(yjs().getDoc()), 'relay'),
  };
}

beforeEach(() => {
  act(() => {
    useCollaborationStore.getState().stopSession?.();
    useDocumentStore.getState().clear();
    useDocumentSettingsStore.setState({ settings: {}, documentId: undefined });
  });
});

afterEach(() => {
  cleanup();
  act(() => {
    useCollaborationStore.getState().stopSession?.();
  });
});

describe('document settings in a collaborative document', () => {
  it('adopts the shared settings on joining, unknown keys included', () => {
    openDocument({ font: "'Source Serif 4', serif", fromANewerBuild: { nested: [1, true] } });
    expect(settings()).toEqual({ font: "'Source Serif 4', serif", fromANewerBuild: { nested: [1, true] } });
  });

  it('adopts them on joining a document with no shapes too', () => {
    openDocument({ font: 'Caveat, cursive' }, { withShapes: false });
    expect(settings()).toEqual({ font: 'Caveat, cursive' });
  });

  it('sends a local change to the shared document', () => {
    openDocument({ font: 'Inter, sans-serif' });
    act(() => useDocumentSettingsStore.getState().set('font', 'Caveat, cursive'));
    expect(yjs().getSettings()).toEqual({ font: 'Caveat, cursive' });
  });

  it('removes a setting from the shared document', () => {
    openDocument({ font: 'Inter, sans-serif', pageSize: 'a4' });
    act(() => useDocumentSettingsStore.getState().set('pageSize', undefined));
    expect(yjs().getSettings()).toEqual({ font: 'Inter, sans-serif' });
  });

  it('shows a peer’s change, without sending it back', () => {
    openDocument({ font: 'Inter, sans-serif' });
    const other = peer();
    const sent = vi.spyOn(yjs(), 'setSetting');
    other.doc.setSetting('font', 'Caveat, cursive');
    other.deliver();
    expect(settings()).toEqual({ font: 'Caveat, cursive' });
    expect(sent).not.toHaveBeenCalled();
    sent.mockRestore();
  });

  it('merges concurrent changes to different settings', () => {
    openDocument({ font: 'Inter, sans-serif' });
    const other = peer();
    act(() => useDocumentSettingsStore.getState().set('font', 'Caveat, cursive'));
    other.doc.setSetting('pageSize', 'a4');
    other.deliver();
    other.receive();
    const merged = { font: 'Caveat, cursive', pageSize: 'a4' };
    expect(yjs().getSettings()).toEqual(merged);
    expect(other.doc.getSettings()).toEqual(merged);
    expect(settings()).toEqual(merged);
  });
});
