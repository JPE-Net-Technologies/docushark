import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

// Mock the relay-facing deps; use the REAL collectionStore.
vi.mock('./relayDocumentStore', () => ({
  getDocProvider: vi.fn(),
  useRelayDocumentStore: { getState: vi.fn() },
}));
vi.mock('./connectionStore', () => ({
  isRelayAuthenticated: vi.fn(() => true),
}));
vi.mock('../collaboration/SyncStateManager', () => ({
  getSyncStateManager: vi.fn(() => ({ hasPendingChanges: () => false })),
}));
vi.mock('./documentRegistry', () => ({
  useDocumentRegistry: { getState: vi.fn() },
}));
vi.mock('./notificationStore', () => ({
  useNotificationStore: { getState: vi.fn() },
}));

import {
  syncedActions,
  reconcileFromRelay,
  assignDocumentsScoped,
  resetWorkspaceSync,
} from './collectionSync';
import { useCollectionStore } from './collectionStore';
import { getDocProvider, useRelayDocumentStore } from './relayDocumentStore';
import { isRelayAuthenticated } from './connectionStore';
import { getSyncStateManager } from '../collaboration/SyncStateManager';
import { useDocumentRegistry } from './documentRegistry';
import { useNotificationStore } from './notificationStore';
import type { DocumentMetadata } from '../types/Document';
import type { RelayCollectionDef } from '../api/relayClient';

const getDocProviderMock = getDocProvider as unknown as Mock;
const relayGetState = useRelayDocumentStore.getState as unknown as Mock;
const authedMock = isRelayAuthenticated as unknown as Mock;
const syncMgrMock = getSyncStateManager as unknown as Mock;
const registryGetState = useDocumentRegistry.getState as unknown as Mock;
const notifyGetState = useNotificationStore.getState as unknown as Mock;
const warningSpy = vi.fn();

function makeProvider(defs: RelayCollectionDef[]) {
  return {
    getCollections: vi.fn(async (): Promise<RelayCollectionDef[]> => defs.map((d) => ({ ...d }))),
    setCollections: vi.fn(async (_defs: RelayCollectionDef[]): Promise<void> => {}),
    setDocumentCollection: vi.fn(async (_docId: string, _collectionId: string | null): Promise<void> => {}),
  };
}
function meta(id: string, collectionId?: string): DocumentMetadata {
  return { id, name: id, pageCount: 1, modifiedAt: 1, createdAt: 1, ...(collectionId ? { collectionId } : {}) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  useCollectionStore.getState().reset();
  authedMock.mockReturnValue(true);
  relayGetState.mockReturnValue({ isRelayDocument: () => true });
  syncMgrMock.mockReturnValue({ hasPendingChanges: () => false });
  warningSpy.mockClear();
  notifyGetState.mockReturnValue({ warning: warningSpy });
  // Default: no registry record (docScopeOf falls back to isRelayDocument).
  registryGetState.mockReturnValue({ getRecord: () => undefined });
});

describe('collectionSync write-through (JP-159)', () => {
  it('pushes membership for a relay doc, skips a local doc', async () => {
    const provider = makeProvider([{ id: 'A', name: 'A', order: 0 }]);
    getDocProviderMock.mockReturnValue(provider);
    relayGetState.mockReturnValue({ isRelayDocument: (id: string) => id === 'relayDoc' });
    await reconcileFromRelay([]); // knownCollectionIds = {A}

    syncedActions.assignDocuments(['relayDoc'], 'A');
    await vi.waitFor(() => expect(provider.setDocumentCollection).toHaveBeenCalledWith('relayDoc', 'A'));

    syncedActions.assignDocuments(['localDoc'], 'A');
    await flush();
    expect(provider.setDocumentCollection).not.toHaveBeenCalledWith('localDoc', 'A');
  });

  it('pushDefinitions is read-modify-write — never PUTs foreign store collections', async () => {
    const provider = makeProvider([{ id: 'A', name: 'A', order: 0 }]);
    getDocProviderMock.mockReturnValue(provider);
    // A foreign collection exists in the GLOBAL store (e.g. another workspace).
    const foreignId = useCollectionStore.getState().createCollection('Foreign');

    const newId = syncedActions.createCollection('Created');
    await vi.waitFor(() => expect(provider.setCollections).toHaveBeenCalled());
    const putCalls = provider.setCollections.mock.calls;
    const put = putCalls[putCalls.length - 1]![0] as RelayCollectionDef[];
    const ids = put.map((d) => d.id);
    expect(ids).toContain('A'); // the workspace's existing def, from getCollections
    expect(ids).toContain(newId); // the new one
    expect(ids).not.toContain(foreignId); // the global-store foreign def is never pushed
  });

  it('skips a membership push to a collection not in the connected workspace', async () => {
    const provider = makeProvider([{ id: 'A', name: 'A', order: 0 }]);
    getDocProviderMock.mockReturnValue(provider);
    await reconcileFromRelay([]); // known = {A}

    syncedActions.assignDocuments(['d'], 'B'); // B not in workspace
    await flush();
    expect(provider.setDocumentCollection).not.toHaveBeenCalled();

    syncedActions.assignDocuments(['d'], 'A'); // A is known
    await vi.waitFor(() => expect(provider.setDocumentCollection).toHaveBeenCalledWith('d', 'A'));
  });

  it('offline (unauthenticated) is a no-op, never throws', async () => {
    authedMock.mockReturnValue(false);
    const provider = makeProvider([]);
    getDocProviderMock.mockReturnValue(provider);

    expect(() => syncedActions.createCollection('X')).not.toThrow();
    syncedActions.assignDocuments(['d'], 'X');
    await flush();
    expect(provider.setCollections).not.toHaveBeenCalled();
    expect(provider.setDocumentCollection).not.toHaveBeenCalled();
  });
});

describe('collectionSync reconcileFromRelay (JP-159)', () => {
  it('hydrates relay defs + memberships, leaves local-doc assignments untouched', async () => {
    const provider = makeProvider([{ id: 'A', name: 'Alpha', order: 0, color: '#fff' }]);
    getDocProviderMock.mockReturnValue(provider);
    // Seed a local-only collection + assignment that reconcile must NOT touch.
    useCollectionStore.getState().hydrateFromRelay({
      definitions: [{ id: 'localCol', name: 'Local', order: 9, createdAt: 1 }],
      memberships: { localDoc: 'localCol' },
    });

    await reconcileFromRelay([meta('d1', 'A'), meta('d2')]);

    const st = useCollectionStore.getState();
    expect(st.collections['A']?.name).toBe('Alpha');
    expect(typeof st.collections['A']?.createdAt).toBe('number');
    expect(st.assignments['d1']).toBe('A'); // relay membership applied
    expect(st.assignments['d2']).toBeUndefined(); // relay-absent → cleared
    expect(st.assignments['localDoc']).toBe('localCol'); // local doc untouched
    expect(st.collections['localCol']).toBeDefined(); // local def preserved
  });

  it('does NOT clear a relay doc with a pending queued save (clear-guard)', async () => {
    syncMgrMock.mockReturnValue({ hasPendingChanges: (id: string) => id === 'd2' });
    const provider = makeProvider([{ id: 'A', name: 'A', order: 0 }]);
    getDocProviderMock.mockReturnValue(provider);
    useCollectionStore.getState().hydrateFromRelay({
      definitions: [{ id: 'A', name: 'A', order: 0, createdAt: 1 }],
      memberships: { d2: 'A' },
    });

    await reconcileFromRelay([meta('d2')]); // relay reports no membership for d2

    expect(useCollectionStore.getState().assignments['d2']).toBe('A'); // preserved (pending save)
  });

  it('tags reconciled definitions workspace-scoped', async () => {
    const provider = makeProvider([{ id: 'A', name: 'A', order: 0 }]);
    getDocProviderMock.mockReturnValue(provider);
    await reconcileFromRelay([]);
    expect(useCollectionStore.getState().collections['A']?.scope).toBe('workspace');
  });
});

describe('collectionSync scope (JP-366)', () => {
  function registryOf(scopeById: Record<string, 'local' | 'remote' | 'cached'>) {
    registryGetState.mockReturnValue({
      getRecord: (id: string) => (scopeById[id] ? { type: scopeById[id] } : undefined),
    });
  }

  it('createCollection scope follows auth: workspace when signed in, local when not', () => {
    authedMock.mockReturnValue(true);
    getDocProviderMock.mockReturnValue(makeProvider([]));
    const ws = syncedActions.createCollection('Team');
    expect(useCollectionStore.getState().collections[ws]?.scope).toBe('workspace');

    authedMock.mockReturnValue(false);
    const local = syncedActions.createCollection('Personal');
    expect(useCollectionStore.getState().collections[local]?.scope).toBe('local');
  });

  it('assigns when document and collection scopes match (no warning)', () => {
    const ws = syncedActions.createCollection('Team', undefined, 'workspace');
    registryOf({ wsDoc: 'remote' });

    assignDocumentsScoped(['wsDoc'], ws);

    expect(useCollectionStore.getState().assignments['wsDoc']).toBe(ws);
    expect(warningSpy).not.toHaveBeenCalled();
  });

  it('blocks a local doc from a workspace collection, with a warning', () => {
    const ws = syncedActions.createCollection('Team', undefined, 'workspace');
    registryOf({ localDoc: 'local' });

    assignDocumentsScoped(['localDoc'], ws);

    expect(useCollectionStore.getState().assignments['localDoc']).toBeUndefined();
    expect(warningSpy).toHaveBeenCalledTimes(1);
  });

  it('blocks a workspace doc from a local collection, with a warning', () => {
    const local = syncedActions.createCollection('Personal', undefined, 'local');
    registryOf({ wsDoc: 'cached' }); // cached relay doc = workspace scope

    assignDocumentsScoped(['wsDoc'], local);

    expect(useCollectionStore.getState().assignments['wsDoc']).toBeUndefined();
    expect(warningSpy).toHaveBeenCalledTimes(1);
  });

  it('partitions a mixed selection: assigns matches, skips + warns on the rest', () => {
    const ws = syncedActions.createCollection('Team', undefined, 'workspace');
    registryOf({ wsDoc: 'remote', localDoc: 'local' });

    assignDocumentsScoped(['wsDoc', 'localDoc'], ws);

    const st = useCollectionStore.getState();
    expect(st.assignments['wsDoc']).toBe(ws); // matched
    expect(st.assignments['localDoc']).toBeUndefined(); // skipped
    expect(warningSpy).toHaveBeenCalledTimes(1);
  });

  it('removal (null) bypasses the guard regardless of scope', () => {
    const ws = syncedActions.createCollection('Team', undefined, 'workspace');
    useCollectionStore.getState().assignDocument('localDoc', ws); // force a (cross-scope) membership
    registryOf({ localDoc: 'local' });

    assignDocumentsScoped(['localDoc'], null);

    expect(useCollectionStore.getState().assignments['localDoc']).toBeUndefined();
    expect(warningSpy).not.toHaveBeenCalled();
  });

  it('resetWorkspaceSync forgets the known workspace set so the membership gate reopens', async () => {
    const provider = makeProvider([{ id: 'A', name: 'A', order: 0 }]);
    getDocProviderMock.mockReturnValue(provider);
    await reconcileFromRelay([]); // known = {A}

    syncedActions.assignDocuments(['d'], 'B'); // B not in workspace → gated out
    await flush();
    expect(provider.setDocumentCollection).not.toHaveBeenCalled();

    resetWorkspaceSync(); // forget {A}

    syncedActions.assignDocuments(['d'], 'B'); // gate empty now → push allowed
    await vi.waitFor(() => expect(provider.setDocumentCollection).toHaveBeenCalledWith('d', 'B'));
  });
});
