/**
 * JP-117: relay saves must route to the document's *home* relay, not whatever
 * relay happens to be connected.
 *
 * A doc belonging to relay A, edited while connected to relay B, must not be
 * pushed to (or queued under) B — it's cached + queued under A and replays
 * when next connected to A. Driven through `saveDocumentPdfSettings` (a
 * read-modify-write that routes its relay push through `pushRelaySaveOrQueue`)
 * and `syncCurrentDocToRelayOnConnect`, mirroring the JP-106 offline tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const cacheMock = vi.hoisted(() => ({
  put: vi.fn<[unknown, string], Promise<void>>(async () => {}),
  getMeta: vi.fn<[string], { relayId: string; cachedAt: number } | null>(() => null),
}));
vi.mock('../storage/RelayDocumentCache', () => ({ RelayDocumentCache: cacheMock }));

const syncManagerMock = vi.hoisted(() => ({
  queueSave: vi.fn<[unknown, string], { id: string }>(() => ({ id: 'op-1' })),
  hasPendingChanges: vi.fn<[string], boolean>(() => false),
  processQueueForHost: vi.fn(async () => []),
}));
vi.mock('../collaboration/SyncStateManager', () => ({
  getSyncStateManager: () => syncManagerMock,
}));

import {
  saveDocumentToStorage,
  saveDocumentPdfSettings,
  syncCurrentDocToRelayOnConnect,
  usePersistenceStore,
} from './persistenceStore';
import { useRelayDocumentStore } from './relayDocumentStore';
import { useConnectionStore } from './connectionStore';
import { useDocumentRegistry } from './documentRegistry';
import type { DiagramDocument, DocumentMetadata } from '../types/Document';
import type { PDFSettings } from '../types/PDFExport';

const RELAY_A = 'relay-a:9876';
const RELAY_B = 'relay-b:9876';
const pdfSettings = { orientation: 'portrait' } as unknown as PDFSettings;

function makeRelayDoc(id: string): DiagramDocument {
  return {
    id,
    name: id,
    pages: {},
    pageOrder: [],
    activePageId: '',
    createdAt: 1,
    modifiedAt: 1,
    version: 1,
    isRelayDocument: true,
  };
}

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

/** Register a doc in the registry as belonging to `relayId` (sets its origin). */
function registerHome(id: string, relayId: string): void {
  useDocumentRegistry.getState().registerRemote(makeMeta(id), relayId, 'owner', 'synced');
}

function connectTo(relayId: string): void {
  useConnectionStore.setState({
    status: 'authenticated',
    host: { address: relayId, url: `http://${relayId}` },
  });
}

describe('JP-117 — relay save routing by origin relay', () => {
  beforeEach(() => {
    localStorage.clear();
    cacheMock.put.mockClear();
    cacheMock.getMeta.mockReset();
    cacheMock.getMeta.mockReturnValue(null);
    syncManagerMock.queueSave.mockClear();
    syncManagerMock.hasPendingChanges.mockReset();
    syncManagerMock.hasPendingChanges.mockReturnValue(false);
    useConnectionStore.getState().reset();
    useDocumentRegistry.setState({ entries: {} } as never);
    useRelayDocumentStore.setState({ authenticated: false });
  });

  it('A-doc edited while connected to B is NOT pushed to B, and queues under A', () => {
    const saveToHost = vi.fn(async () => ({ newVersion: 1 }));
    useRelayDocumentStore.setState({ authenticated: true, saveToHost } as never);
    registerHome('doc-A', RELAY_A);
    connectTo(RELAY_B); // connected to the wrong relay
    saveDocumentToStorage(makeRelayDoc('doc-A'));

    const ok = saveDocumentPdfSettings('doc-A', pdfSettings);

    expect(ok).toBe(true);
    // Never written to the connected (wrong) relay.
    expect(saveToHost).not.toHaveBeenCalled();
    // Cached + queued under the doc's HOME relay, not the connected one.
    expect(syncManagerMock.queueSave).toHaveBeenCalledTimes(1);
    expect(syncManagerMock.queueSave.mock.calls[0]?.[1]).toBe(RELAY_A);
    expect(cacheMock.put).toHaveBeenCalledTimes(1);
    expect(cacheMock.put.mock.calls[0]?.[1]).toBe(RELAY_A);
  });

  it('pushes immediately when the connected relay IS the doc home', () => {
    const saveToHost = vi.fn(async () => ({ newVersion: 1 }));
    useRelayDocumentStore.setState({ authenticated: true, saveToHost } as never);
    registerHome('doc-A', RELAY_A);
    connectTo(RELAY_A); // connected to the right relay
    saveDocumentToStorage(makeRelayDoc('doc-A'));

    const ok = saveDocumentPdfSettings('doc-A', pdfSettings);

    expect(ok).toBe(true);
    expect(saveToHost).toHaveBeenCalledTimes(1);
    expect(syncManagerMock.queueSave).not.toHaveBeenCalled();
  });

  it('cold boot (registry empty): resolves origin from the persistent cache and queues under it', () => {
    // No registry record; the durable cache remembers the home relay.
    cacheMock.getMeta.mockReturnValue({ relayId: RELAY_A, cachedAt: 1 });
    useRelayDocumentStore.setState({ authenticated: false }); // cold boot, offline
    useConnectionStore.setState({ status: 'disconnected' }); // no host
    saveDocumentToStorage(makeRelayDoc('doc-cold'));

    const ok = saveDocumentPdfSettings('doc-cold', pdfSettings);

    expect(ok).toBe(true);
    expect(syncManagerMock.queueSave).toHaveBeenCalledTimes(1);
    expect(syncManagerMock.queueSave.mock.calls[0]?.[1]).toBe(RELAY_A);
    expect(cacheMock.put.mock.calls[0]?.[1]).toBe(RELAY_A);
  });

  it('brand-new doc with no known origin pushes to the connected relay', () => {
    const saveToHost = vi.fn(async () => ({ newVersion: 1 }));
    useRelayDocumentStore.setState({ authenticated: true, saveToHost } as never);
    // No registry record, no cache meta -> origin unknown -> treat connected as home.
    connectTo(RELAY_B);
    saveDocumentToStorage(makeRelayDoc('doc-new'));

    const ok = saveDocumentPdfSettings('doc-new', pdfSettings);

    expect(ok).toBe(true);
    expect(saveToHost).toHaveBeenCalledTimes(1);
    expect(syncManagerMock.queueSave).not.toHaveBeenCalled();
  });

  it('registry never re-homes a doc: registering it from another relay keeps the origin', () => {
    const registry = useDocumentRegistry.getState();
    registry.registerRemote(makeMeta('doc-imm'), RELAY_A, 'owner', 'synced');
    // Simulate fetchDocumentList while connected to B listing the same id.
    registry.registerRemote(makeMeta('doc-imm'), RELAY_B, 'owner', 'synced');

    const rec = useDocumentRegistry.getState().getRecord('doc-imm') as { relayId?: string };
    expect(rec.relayId).toBe(RELAY_A);
  });

  it('registry cold-boot resolves origin from the durable cache, not the connected relay', () => {
    // Registry empty for this id; the cache remembers it was first seen on A.
    cacheMock.getMeta.mockImplementation((id: string) =>
      id === 'doc-cold-reg' ? { relayId: RELAY_A, cachedAt: 1 } : null,
    );
    useDocumentRegistry.getState().registerRemote(makeMeta('doc-cold-reg'), RELAY_B, 'owner', 'synced');

    const rec = useDocumentRegistry.getState().getRecord('doc-cold-reg') as { relayId?: string };
    expect(rec.relayId).toBe(RELAY_A);
  });

  it('a flip attempt (register under B) does not leak a subsequent save to B', () => {
    const saveToHost = vi.fn(async () => ({ newVersion: 1 }));
    useRelayDocumentStore.setState({ authenticated: true, saveToHost } as never);
    // Doc's home is A; then B's list tries to re-home it (the old bug).
    useDocumentRegistry.getState().registerRemote(makeMeta('doc-flip'), RELAY_A, 'owner', 'synced');
    useDocumentRegistry.getState().registerRemote(makeMeta('doc-flip'), RELAY_B, 'owner', 'synced');
    connectTo(RELAY_B);
    saveDocumentToStorage(makeRelayDoc('doc-flip'));

    saveDocumentPdfSettings('doc-flip', pdfSettings);

    expect(saveToHost).not.toHaveBeenCalled();
    expect(syncManagerMock.queueSave.mock.calls[0]?.[1]).toBe(RELAY_A);
  });

  it('syncCurrentDocToRelayOnConnect does not push a doc whose home is a different relay', async () => {
    const saveToHost = vi.fn(async () => ({ newVersion: 2 }));
    usePersistenceStore.getState().newDocument('OnConnect');
    const stored = makeRelayDoc('doc-conn');
    stored.serverVersion = 5;
    saveDocumentToStorage(stored);
    registerHome('doc-conn', RELAY_A); // home is A
    useRelayDocumentStore.setState({ authenticated: true, saveToHost } as never);
    connectTo(RELAY_B); // connected to B
    usePersistenceStore.setState({
      currentDocumentId: 'doc-conn',
      isDirty: true,
      teamDocContentPending: false,
    });

    await syncCurrentDocToRelayOnConnect();

    expect(saveToHost).not.toHaveBeenCalled();
  });
});
