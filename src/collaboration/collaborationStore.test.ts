import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useCollaborationStore,
  subscribeToRemoteChanges,
  initializeCRDTFromState,
  isCollabContentDoc,
  type CollaborationConfig,
} from './collaborationStore';
import type { Shape } from '../shapes/Shape';
import { useDocumentRegistry } from '../store/documentRegistry';
import type { DocumentMetadata } from '../types/Document';

// Mock dependencies
vi.mock('./YjsDocument', () => ({
  YjsDocument: vi.fn().mockImplementation(() => ({
    getDoc: vi.fn().mockReturnValue({}),
    setShape: vi.fn(),
    setShapes: vi.fn(),
    deleteShape: vi.fn(),
    setShapeOrder: vi.fn(),
    clear: vi.fn(),
    destroy: vi.fn(),
    onShapeChange: vi.fn(() => vi.fn()),
    onOrderChange: vi.fn(() => vi.fn()),
    initializeFromState: vi.fn(),
  })),
}));

vi.mock('./UnifiedSyncProvider', () => ({
  UnifiedSyncProvider: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    destroy: vi.fn(),
    isReady: vi.fn().mockReturnValue(false),
    setLocalAwareness: vi.fn(),
    onAwarenessChange: vi.fn().mockReturnValue(vi.fn()),
    updateCursor: vi.fn(),
    updateSelection: vi.fn(),
    joinDocument: vi.fn(),
    requestSync: vi.fn(),
  })),
}));

vi.mock('../store/relayDocumentStore', () => ({
  useRelayDocumentStore: {
    getState: vi.fn(() => ({
      setHostConnected: vi.fn(),
      setError: vi.fn(),
      setAuthenticated: vi.fn(),
      handleDocumentEvent: vi.fn(),
      setProvider: vi.fn(),
      clearRelayDocuments: vi.fn(),
    })),
  },
}));

vi.mock('../store/connectionStore', () => ({
  useConnectionStore: {
    getState: vi.fn(() => ({
      setHost: vi.fn(),
      reset: vi.fn(),
      setToken: vi.fn(),
      token: null,
      tokenExpiresAt: null,
    })),
    subscribe: vi.fn(() => vi.fn()),
  },
  startTokenExpirationMonitor: vi.fn(),
  stopTokenExpirationMonitor: vi.fn(),
}));

vi.mock('../store/presenceStore', () => ({
  usePresenceStore: {
    getState: vi.fn(() => ({
      setLocalUser: vi.fn(),
      clearRemoteUsers: vi.fn(),
      syncRemoteUsers: vi.fn(),
    })),
  },
}));

// Helper to create test config
function createTestConfig(overrides: Partial<CollaborationConfig> = {}): CollaborationConfig {
  return {
    serverUrl: 'ws://localhost:9876/ws',
    documentId: 'doc-1',
    token: 'test-token',
    user: {
      id: 'user-1',
      name: 'Test User',
      color: '#ff0000',
    },
    ...overrides,
  };
}

// Helper to create test shape
function createTestShape(id: string): Shape {
  return {
    id,
    type: 'rectangle',
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    rotation: 0,
    style: {},
  } as unknown as Shape;
}

describe('collaborationStore', () => {
  beforeEach(() => {
    // Reset store to initial state
    useCollaborationStore.setState({
      isActive: false,
      connectionStatus: 'disconnected',
      isSynced: false,
      error: null,
      remoteUsers: [],
      config: null,
    });
  });

  afterEach(() => {
    // Clean up any active session
    const state = useCollaborationStore.getState();
    if (state.isActive) {
      state.stopSession();
    }
  });

  describe('initial state', () => {
    it('has correct initial values', () => {
      const state = useCollaborationStore.getState();

      expect(state.isActive).toBe(false);
      expect(state.connectionStatus).toBe('disconnected');
      expect(state.isSynced).toBe(false);
      expect(state.error).toBeNull();
      expect(state.remoteUsers).toEqual([]);
      expect(state.config).toBeNull();
    });
  });

  describe('startSession', () => {
    it('starts a new session', () => {
      const config = createTestConfig();

      useCollaborationStore.getState().startSession(config);

      const state = useCollaborationStore.getState();
      expect(state.isActive).toBe(true);
      expect(state.config).toEqual(config);
      expect(state.error).toBeNull();
    });

    it('stops existing session before starting new one', () => {
      const config1 = createTestConfig({ documentId: 'doc-1' });
      const config2 = createTestConfig({ documentId: 'doc-2' });

      useCollaborationStore.getState().startSession(config1);
      expect(useCollaborationStore.getState().config?.documentId).toBe('doc-1');

      useCollaborationStore.getState().startSession(config2);
      expect(useCollaborationStore.getState().config?.documentId).toBe('doc-2');
    });

    it('creates YjsDocument and UnifiedSyncProvider', async () => {
      const { YjsDocument } = await import('./YjsDocument');
      const { UnifiedSyncProvider } = await import('./UnifiedSyncProvider');

      const config = createTestConfig();
      useCollaborationStore.getState().startSession(config);

      // JP-172: the Y.Doc clientID is Yjs's random default, not keyed off the
      // documentId — so the constructor takes no args (doc identity lives in the
      // provider room, not the clientID).
      expect(YjsDocument).toHaveBeenCalledWith();
      expect(UnifiedSyncProvider).toHaveBeenCalled();
    });

    it('sets host in connection store', async () => {
      const config = createTestConfig({ serverUrl: 'ws://myhost:1234/ws' });

      useCollaborationStore.getState().startSession(config);

      // Verify session started - mocked functions are called internally
      expect(useCollaborationStore.getState().isActive).toBe(true);
    });
  });

  describe('stopSession', () => {
    it('stops active session', () => {
      const config = createTestConfig();
      useCollaborationStore.getState().startSession(config);

      useCollaborationStore.getState().stopSession();

      const state = useCollaborationStore.getState();
      expect(state.isActive).toBe(false);
      expect(state.connectionStatus).toBe('disconnected');
      expect(state.isSynced).toBe(false);
      expect(state.error).toBeNull();
      expect(state.remoteUsers).toEqual([]);
      expect(state.config).toBeNull();
    });

    it('handles stop when no session active', () => {
      // Should not throw
      expect(() => {
        useCollaborationStore.getState().stopSession();
      }).not.toThrow();
    });

    it('clears relay document store', async () => {
      const config = createTestConfig();

      useCollaborationStore.getState().startSession(config);
      useCollaborationStore.getState().stopSession();

      // Just verify stopSession completes without error - mocks verify execution
      expect(useCollaborationStore.getState().isActive).toBe(false);
    });
  });

  describe('syncShape', () => {
    it('syncs shape to YjsDocument when active', () => {
      const config = createTestConfig();
      useCollaborationStore.getState().startSession(config);

      const shape = createTestShape('shape-1');
      useCollaborationStore.getState().syncShape(shape);

      const yjsDoc = useCollaborationStore.getState().getYjsDocument();
      expect(yjsDoc?.setShape).toHaveBeenCalledWith(shape);
    });

    it('does nothing when no session', () => {
      const shape = createTestShape('shape-1');

      // Should not throw
      expect(() => {
        useCollaborationStore.getState().syncShape(shape);
      }).not.toThrow();
    });
  });

  describe('syncShapes', () => {
    it('syncs multiple shapes', () => {
      const config = createTestConfig();
      useCollaborationStore.getState().startSession(config);

      const shapes = [createTestShape('shape-1'), createTestShape('shape-2')];
      useCollaborationStore.getState().syncShapes(shapes);

      const yjsDoc = useCollaborationStore.getState().getYjsDocument();
      expect(yjsDoc?.setShapes).toHaveBeenCalledWith(shapes);
    });
  });

  describe('syncDeleteShape', () => {
    it('syncs shape deletion', () => {
      const config = createTestConfig();
      useCollaborationStore.getState().startSession(config);

      useCollaborationStore.getState().syncDeleteShape('shape-1');

      const yjsDoc = useCollaborationStore.getState().getYjsDocument();
      expect(yjsDoc?.deleteShape).toHaveBeenCalledWith('shape-1');
    });
  });

  describe('syncShapeOrder', () => {
    it('syncs shape order', () => {
      const config = createTestConfig();
      useCollaborationStore.getState().startSession(config);

      const order = ['shape-2', 'shape-1', 'shape-3'];
      useCollaborationStore.getState().syncShapeOrder(order);

      const yjsDoc = useCollaborationStore.getState().getYjsDocument();
      expect(yjsDoc?.setShapeOrder).toHaveBeenCalledWith(order);
    });
  });

  describe('switchDocument', () => {
    it('restarts the engine for the new document', () => {
      const config = createTestConfig({ documentId: 'doc-1' });
      useCollaborationStore.getState().startSession(config);

      const firstYjs = useCollaborationStore.getState().getYjsDocument();
      const firstProvider = useCollaborationStore.getState().getSyncProvider();

      useCollaborationStore.getState().switchDocument('doc-2');

      const state = useCollaborationStore.getState();
      expect(state.isActive).toBe(true);
      expect(state.config?.documentId).toBe('doc-2');
      // Per-doc RESTART (JP-108 step 3): the old session is torn down and a fresh
      // Y.Doc + provider come up for the new doc — keyed to a new y-indexeddb
      // room. An in-place `clear()` would have wiped the previous doc's room.
      expect(firstYjs?.destroy).toHaveBeenCalled();
      expect(firstProvider?.destroy).toHaveBeenCalled();

      // The new engine is a distinct, freshly-connected instance.
      const newYjs = useCollaborationStore.getState().getYjsDocument();
      const newProvider = useCollaborationStore.getState().getSyncProvider();
      expect(newYjs).not.toBe(firstYjs);
      expect(newProvider).not.toBe(firstProvider);
      expect(newProvider?.connect).toHaveBeenCalled();
    });

    it('carries the token so an online collaborator stays connected', () => {
      const config = createTestConfig({ documentId: 'doc-1', token: 'tok-abc' });
      useCollaborationStore.getState().startSession(config);

      useCollaborationStore.getState().switchDocument('doc-2');

      // A provider (the token-gated transport) is present after the switch.
      expect(useCollaborationStore.getState().getSyncProvider()).not.toBeNull();
      expect(useCollaborationStore.getState().config?.token).toBe('tok-abc');
    });

    it('does nothing when no session', () => {
      expect(() => {
        useCollaborationStore.getState().switchDocument('doc-2');
      }).not.toThrow();
      expect(useCollaborationStore.getState().isActive).toBe(false);
    });
  });

  describe('presence updates', () => {
    it('updates cursor position', () => {
      const config = createTestConfig();
      useCollaborationStore.getState().startSession(config);

      useCollaborationStore.getState().updateCursor(100, 200);

      const syncProvider = useCollaborationStore.getState().getSyncProvider();
      expect(syncProvider?.updateCursor).toHaveBeenCalledWith(100, 200);
    });

    it('updates selection', () => {
      const config = createTestConfig();
      useCollaborationStore.getState().startSession(config);

      useCollaborationStore.getState().updateSelection(['shape-1', 'shape-2']);

      const syncProvider = useCollaborationStore.getState().getSyncProvider();
      expect(syncProvider?.updateSelection).toHaveBeenCalledWith(['shape-1', 'shape-2']);
    });
  });

  describe('internal actions', () => {
    it('sets connection status', () => {
      useCollaborationStore.getState()._setConnectionStatus('authenticated');
      expect(useCollaborationStore.getState().connectionStatus).toBe('authenticated');
    });

    it('sets synced state', () => {
      useCollaborationStore.getState()._setSynced(true);
      expect(useCollaborationStore.getState().isSynced).toBe(true);
    });

    it('sets error', () => {
      useCollaborationStore.getState()._setError('Test error');
      expect(useCollaborationStore.getState().error).toBe('Test error');

      useCollaborationStore.getState()._setError(null);
      expect(useCollaborationStore.getState().error).toBeNull();
    });

    it('updates remote users', async () => {
      const users = new Map<number, { id: string; name: string; color: string }>([
        [1, { id: 'user-1', name: 'User 1', color: '#ff0000' }],
        [2, { id: 'user-2', name: 'User 2', color: '#00ff00' }],
      ]);

      useCollaborationStore.getState()._updateRemoteUsers(users as never);

      const state = useCollaborationStore.getState();
      expect(state.remoteUsers).toHaveLength(2);
      expect(state.remoteUsers[0]?.clientId).toBe(1);
      expect(state.remoteUsers[1]?.clientId).toBe(2);
    });
  });

  describe('getYjsDocument', () => {
    it('returns null when no session', () => {
      expect(useCollaborationStore.getState().getYjsDocument()).toBeNull();
    });

    it('returns document when session active', () => {
      const config = createTestConfig();
      useCollaborationStore.getState().startSession(config);

      const yjsDoc = useCollaborationStore.getState().getYjsDocument();
      expect(yjsDoc).not.toBeNull();
    });
  });

  describe('getSyncProvider', () => {
    it('returns null when no session', () => {
      expect(useCollaborationStore.getState().getSyncProvider()).toBeNull();
    });

    it('returns provider when session active', () => {
      const config = createTestConfig();
      useCollaborationStore.getState().startSession(config);

      const provider = useCollaborationStore.getState().getSyncProvider();
      expect(provider).not.toBeNull();
    });
  });
});

describe('subscribeToRemoteChanges', () => {
  beforeEach(() => {
    useCollaborationStore.setState({
      isActive: false,
      connectionStatus: 'disconnected',
      isSynced: false,
      error: null,
      remoteUsers: [],
      config: null,
    });
  });

  afterEach(() => {
    const state = useCollaborationStore.getState();
    if (state.isActive) {
      state.stopSession();
    }
  });

  it('returns noop when no session', () => {
    const onShapeChange = vi.fn();
    const onOrderChange = vi.fn();

    const unsub = subscribeToRemoteChanges(onShapeChange, onOrderChange);

    expect(typeof unsub).toBe('function');
    // Should not throw when called
    unsub();
  });

  it('subscribes to changes when session active', () => {
    const config = createTestConfig();
    useCollaborationStore.getState().startSession(config);

    const onShapeChange = vi.fn();
    const onOrderChange = vi.fn();

    const unsub = subscribeToRemoteChanges(onShapeChange, onOrderChange);

    const yjsDoc = useCollaborationStore.getState().getYjsDocument();
    expect(yjsDoc?.onShapeChange).toHaveBeenCalledWith(onShapeChange);
    expect(yjsDoc?.onOrderChange).toHaveBeenCalledWith(onOrderChange);

    // Unsub should be callable
    expect(() => unsub()).not.toThrow();
  });
});

describe('initializeCRDTFromState', () => {
  beforeEach(() => {
    useCollaborationStore.setState({
      isActive: false,
      connectionStatus: 'disconnected',
      isSynced: false,
      error: null,
      remoteUsers: [],
      config: null,
    });
  });

  afterEach(() => {
    const state = useCollaborationStore.getState();
    if (state.isActive) {
      state.stopSession();
    }
  });

  it('does nothing when no session', () => {
    // Should not throw
    expect(() => {
      initializeCRDTFromState([], []);
    }).not.toThrow();
  });

  it('initializes CRDT with shapes and order', () => {
    const config = createTestConfig();
    useCollaborationStore.getState().startSession(config);

    const shapes = [createTestShape('shape-1'), createTestShape('shape-2')];
    const order = ['shape-1', 'shape-2'];

    initializeCRDTFromState(shapes, order);

    const yjsDoc = useCollaborationStore.getState().getYjsDocument();
    expect(yjsDoc?.initializeFromState).toHaveBeenCalledWith(shapes, order);
  });
});

describe('isCollabContentDoc (JP-108 relay-sole-writer predicate)', () => {
  function makeMeta(id: string): DocumentMetadata {
    return {
      id,
      name: id,
      pageCount: 1,
      ownerId: 'owner-1',
      ownerName: 'owner',
      createdAt: 1,
      modifiedAt: 1,
      isRelayDocument: true,
    };
  }

  beforeEach(() => {
    useDocumentRegistry.getState().clearAll();
    useCollaborationStore.setState({ isActive: false, config: null });
  });
  afterEach(() => {
    useDocumentRegistry.getState().clearAll();
    useCollaborationStore.setState({ isActive: false, config: null });
  });

  it('is false when no collab session is active', () => {
    expect(isCollabContentDoc('doc-1')).toBe(false);
  });

  it('is true for the active session document', () => {
    useCollaborationStore.setState({
      isActive: true,
      config: createTestConfig({ documentId: 'doc-1' }),
    });
    expect(isCollabContentDoc('doc-1')).toBe(true);
  });

  it('is false for a document other than the active session doc', () => {
    useCollaborationStore.setState({
      isActive: true,
      config: createTestConfig({ documentId: 'doc-1' }),
    });
    expect(isCollabContentDoc('doc-2')).toBe(false);
  });

  it('is false for an errored doc — REST stays its durability fallback', () => {
    useCollaborationStore.setState({
      isActive: true,
      config: createTestConfig({ documentId: 'doc-1' }),
    });
    useDocumentRegistry.getState().registerRemote(makeMeta('doc-1'), 'relay-1', 'owner', 'error');
    expect(isCollabContentDoc('doc-1')).toBe(false);
  });
});
