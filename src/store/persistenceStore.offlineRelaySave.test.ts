/**
 * JP-106: edits to a relay document made while offline must not be lost.
 *
 * The live `isRelayAuthenticated()` gate is false while offline, so the
 * old code never attempted (or queued) the save and the edit died on
 * close. `pushRelaySaveOrQueue` now caches the snapshot and enqueues it
 * for replay whenever the client has an active relay session
 * (`relayDocumentStore.authenticated`) but can't currently reach the host.
 *
 * We exercise the helper through the exported `saveDocumentPdfSettings`
 * entry point, which does a lightweight read-modify-write and routes its
 * relay push through the helper.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const cacheMock = vi.hoisted(() => ({
  put: vi.fn<[unknown, string], Promise<void>>(async () => {}),
  // JP-117: save routing now resolves a doc's home relay, consulting the
  // persistent cache as a fallback origin source. Default to no cached origin.
  getMeta: vi.fn<[string], { relayId: string; cachedAt: number } | null>(() => null),
}));
vi.mock('../storage/RelayDocumentCache', () => ({ RelayDocumentCache: cacheMock }));

const syncManagerMock = vi.hoisted(() => ({
  queueSave: vi.fn(() => ({ id: 'op-1' })),
  hasPendingChanges: vi.fn<[string], boolean>(() => false),
  processQueueForHost: vi.fn(async () => []),
}));
vi.mock('../collaboration/SyncStateManager', () => ({
  getSyncStateManager: () => syncManagerMock,
}));

import {
  saveDocumentToStorage,
  saveDocumentPdfSettings,
  reattachAwaitingTeamDocument,
  syncCurrentDocToRelayOnConnect,
  usePersistenceStore,
} from './persistenceStore';
import { useRelayDocumentStore } from './relayDocumentStore';
import { useConnectionStore } from './connectionStore';
import { useNotificationStore } from './notificationStore';
import { VersionConflictError } from '../api/relayClient';
import type { DiagramDocument } from '../types/Document';
import type { PDFSettings } from '../types/PDFExport';

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

const pdfSettings = { orientation: 'portrait' } as unknown as PDFSettings;

describe('saveDocumentPdfSettings — offline relay edit durability (JP-106)', () => {
  beforeEach(() => {
    localStorage.clear();
    cacheMock.put.mockClear();
    syncManagerMock.queueSave.mockClear();
    syncManagerMock.hasPendingChanges.mockReset();
    syncManagerMock.hasPendingChanges.mockReturnValue(false);
    useConnectionStore.getState().reset();
    useRelayDocumentStore.setState({ authenticated: false });
  });

  it('caches + queues the save when the relay session is offline', () => {
    // Active relay session, but the live connection is down.
    useRelayDocumentStore.setState({ authenticated: true });
    useConnectionStore.setState({
      status: 'disconnected',
      host: { address: 'localhost:9876', url: 'http://localhost:9876' },
    });
    saveDocumentToStorage(makeRelayDoc('relay-doc-1'));

    const ok = saveDocumentPdfSettings('relay-doc-1', pdfSettings);

    expect(ok).toBe(true);
    expect(cacheMock.put).toHaveBeenCalledTimes(1);
    expect(cacheMock.put.mock.calls[0]?.[1]).toBe('localhost:9876');
    expect(syncManagerMock.queueSave).toHaveBeenCalledTimes(1);
  });

  it('pins collected blob references onto the cached + queued snapshot (JP-127)', () => {
    // The data-loss case: a doc references a blob (FileShape.blobRef) but its
    // GC list (`blobReferences`) is empty/stale. Pre-fix the offline-queued
    // snapshot kept that empty list, so on reconnect the replay saved a
    // ref-less doc → the relay released the ACL → the blob was orphaned + GC'd.
    useRelayDocumentStore.setState({ authenticated: true });
    useConnectionStore.setState({
      status: 'disconnected',
      host: { address: 'localhost:9876', url: 'http://localhost:9876' },
    });
    const doc = makeRelayDoc('relay-doc-asset');
    doc.pages = {
      p1: { id: 'p1', name: 'P1', shapes: { s1: { id: 's1', type: 'file', blobRef: 'hash-abc' } } },
    } as unknown as DiagramDocument['pages'];
    doc.pageOrder = ['p1'];
    doc.activePageId = 'p1';
    expect(doc.blobReferences).toBeUndefined();
    saveDocumentToStorage(doc);

    const ok = saveDocumentPdfSettings('relay-doc-asset', pdfSettings);

    expect(ok).toBe(true);
    expect(syncManagerMock.queueSave).toHaveBeenCalledTimes(1);
    const queuedCalls = syncManagerMock.queueSave.mock.calls as unknown as Array<[DiagramDocument, string]>;
    expect(queuedCalls[0]?.[0]?.blobReferences).toContain('hash-abc');
    // The cached snapshot carries them too (same reconciled doc).
    const cachedCalls = cacheMock.put.mock.calls as unknown as Array<[DiagramDocument, string]>;
    expect(cachedCalls[0]?.[0]?.blobReferences).toContain('hash-abc');
  });

  it('queues on a COLD BOOT before any connection (authenticated=false) — JP-106 follow-up', () => {
    // The reboot data-loss case: edits made offline before the relay session
    // exists this boot. `relayDocumentStore.authenticated` is not persisted,
    // so it is false here — but a relay doc still has a relay home, so the
    // edit must be cached + queued, not dropped.
    useRelayDocumentStore.setState({ authenticated: false });
    useConnectionStore.setState({ status: 'disconnected' });
    saveDocumentToStorage(makeRelayDoc('relay-doc-2'));

    const ok = saveDocumentPdfSettings('relay-doc-2', pdfSettings);

    expect(ok).toBe(true);
    expect(cacheMock.put).toHaveBeenCalledTimes(1);
    expect(syncManagerMock.queueSave).toHaveBeenCalledTimes(1);
  });

  it('does not queue for a purely local document', () => {
    useRelayDocumentStore.setState({ authenticated: true });
    useConnectionStore.setState({ status: 'disconnected' });
    const localDoc = makeRelayDoc('local-doc');
    localDoc.isRelayDocument = false;
    saveDocumentToStorage(localDoc);

    const ok = saveDocumentPdfSettings('local-doc', pdfSettings);

    expect(ok).toBe(true);
    expect(syncManagerMock.queueSave).not.toHaveBeenCalled();
  });
});

describe('pushRelaySaveOrQueue — connected-save failure handling (JP-127)', () => {
  // Drain the fire-and-forget `saveToHost(doc).catch(...)` microtask.
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    localStorage.clear();
    cacheMock.put.mockClear();
    syncManagerMock.queueSave.mockClear();
    syncManagerMock.hasPendingChanges.mockReset();
    syncManagerMock.hasPendingChanges.mockReturnValue(false);
    useConnectionStore.getState().reset();
    useRelayDocumentStore.setState({ authenticated: false });
    // Connected + authenticated so the helper actually attempts saveToHost.
    useConnectionStore.setState({
      status: 'authenticated',
      host: { address: 'localhost:9876', url: 'http://localhost:9876' },
    });
  });

  it('queues for replay when a connected save fails transiently — not just "Not connected"', async () => {
    // Pre-fix: any error other than the literal "Not connected to host" was
    // logged and dropped, so the edit was lost and a later reattach rolled the
    // doc back. A stalled/aborted upload or a 5xx must now be queued instead.
    const saveToHost = vi.fn(async () => {
      throw new Error('Failed to upload 1 of 1 asset(s) to the relay: network blip');
    });
    useRelayDocumentStore.setState({ authenticated: true, saveToHost } as never);
    saveDocumentToStorage(makeRelayDoc('relay-transient'));

    saveDocumentPdfSettings('relay-transient', pdfSettings);
    await flush();

    expect(saveToHost).toHaveBeenCalledTimes(1);
    expect(syncManagerMock.queueSave).toHaveBeenCalledTimes(1);
    expect(cacheMock.put).toHaveBeenCalledTimes(1);
    expect(cacheMock.put.mock.calls[0]?.[1]).toBe('localhost:9876');
  });

  it('surfaces an over-quota (507) failure without queuing or silently dropping', async () => {
    const err = Object.assign(
      new Error('storage quota exceeded: 250 used + 10 incoming > 250 quota'),
      { status: 507 },
    );
    const saveToHost = vi.fn(async () => {
      throw err;
    });
    useRelayDocumentStore.setState({ authenticated: true, saveToHost } as never);
    saveDocumentToStorage(makeRelayDoc('relay-quota'));
    const errorSpy = vi.spyOn(useNotificationStore.getState(), 'error');

    saveDocumentPdfSettings('relay-quota', pdfSettings);
    await flush();

    expect(errorSpy).toHaveBeenCalled();
    // Terminal: a blind replay can't fix it, so don't queue — but the local
    // copy is kept (not dropped), and reattach won't clobber it.
    expect(syncManagerMock.queueSave).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('saveDocument — defect-D guard narrowed to unhydrated parked docs (JP-106 follow-up)', () => {
  beforeEach(() => {
    localStorage.clear();
    syncManagerMock.queueSave.mockClear();
    useConnectionStore.getState().reset();
    useRelayDocumentStore.setState({ authenticated: false });
    usePersistenceStore.getState().reset();
  });

  it('bails when a relay doc is parked WITHOUT hydrated content', () => {
    // teamDocContentPending = parked unhydrated → saving would blank the
    // relay doc / mint an orphan id, so saveDocument must no-op.
    usePersistenceStore.setState({
      currentDocumentId: null,
      isAwaitingTeamLoad: true,
      teamDocContentPending: true,
    });

    usePersistenceStore.getState().saveDocument();

    // No id minted, nothing serialized.
    expect(usePersistenceStore.getState().currentDocumentId).toBeNull();
  });

  it('still saves when only isAwaitingTeamLoad is set (hydrated reboot path)', () => {
    // The regression case: a relay doc hydrated from cache on reboot is
    // `isAwaitingTeamLoad` but its content IS loaded, so offline edits must
    // persist. newDocument hydrates the page store with a real doc.
    usePersistenceStore.getState().newDocument('Hydrated');
    usePersistenceStore.setState({
      isAwaitingTeamLoad: true,
      teamDocContentPending: false,
    });

    usePersistenceStore.getState().saveDocument();

    expect(usePersistenceStore.getState().currentDocumentId).not.toBeNull();
    expect(usePersistenceStore.getState().lastSavedAt).not.toBeNull();
  });
});

describe('reattachAwaitingTeamDocument — no clobber of unsynced edits (JP-106 follow-up)', () => {
  beforeEach(() => {
    localStorage.clear();
    cacheMock.put.mockClear();
    syncManagerMock.queueSave.mockClear();
    syncManagerMock.processQueueForHost.mockClear();
    syncManagerMock.hasPendingChanges.mockReset();
    syncManagerMock.hasPendingChanges.mockReturnValue(false);
    useConnectionStore.getState().reset();
    useRelayDocumentStore.setState({ authenticated: false });
    usePersistenceStore.getState().reset();
  });

  it('does NOT fetch/overwrite when the local copy has unsynced edits', async () => {
    const loadRelayDocument = vi.fn(async () => makeRelayDoc('doc-X'));
    useRelayDocumentStore.setState({ loadRelayDocument } as never);
    syncManagerMock.hasPendingChanges.mockReturnValue(true);
    usePersistenceStore.setState({
      currentDocumentId: 'doc-X',
      isAwaitingTeamLoad: true,
      teamDocContentPending: false,
    });

    await reattachAwaitingTeamDocument();

    expect(loadRelayDocument).not.toHaveBeenCalled();
    // Reattach hook disengaged so it doesn't keep retrying.
    expect(usePersistenceStore.getState().isAwaitingTeamLoad).toBe(false);
  });

  it('does fetch when there are no pending edits (normal reattach)', async () => {
    const loadRelayDocument = vi.fn(async () => makeRelayDoc('doc-Y'));
    useRelayDocumentStore.setState({ loadRelayDocument } as never);
    syncManagerMock.hasPendingChanges.mockReturnValue(false);
    usePersistenceStore.setState({
      currentDocumentId: 'doc-Y',
      isAwaitingTeamLoad: true,
      teamDocContentPending: false,
    });

    await reattachAwaitingTeamDocument();

    expect(loadRelayDocument).toHaveBeenCalledWith('doc-Y');
  });

  it('keeps a NEWER local copy and queues a replay instead of clobbering (JP-127)', async () => {
    // The real data-loss path: a save failed/was-interrupted without ever
    // queuing (hasPendingChanges=false), so the local copy is newer than the
    // relay's and holds the unsynced edit (e.g. a just-added file). Reattach
    // must keep it and queue a replay, not overwrite it with the stale relay copy.
    const localNewer = makeRelayDoc('doc-newer');
    localNewer.modifiedAt = 5000;
    localNewer.blobReferences = [];
    localNewer.pages = {
      p1: { id: 'p1', name: 'P1', shapes: { s1: { id: 's1', type: 'file', blobRef: 'hash-keep' } } },
    } as unknown as DiagramDocument['pages'];
    saveDocumentToStorage(localNewer);

    const relayOlder = makeRelayDoc('doc-newer');
    relayOlder.modifiedAt = 1; // stale relay copy, pre-edit
    const loadRelayDocument = vi.fn(async () => relayOlder);
    useRelayDocumentStore.setState({ loadRelayDocument } as never);
    useConnectionStore.setState({
      status: 'authenticated',
      host: { address: 'localhost:9876', url: 'http://localhost:9876' },
    });
    syncManagerMock.hasPendingChanges.mockReturnValue(false);
    usePersistenceStore.setState({
      currentDocumentId: 'doc-newer',
      isAwaitingTeamLoad: true,
      teamDocContentPending: false,
    });

    await reattachAwaitingTeamDocument();

    expect(loadRelayDocument).toHaveBeenCalledWith('doc-newer');
    // Kept local + queued for replay (not clobbered).
    expect(syncManagerMock.queueSave).toHaveBeenCalledTimes(1);
    const queued = syncManagerMock.queueSave.mock.calls as unknown as Array<[DiagramDocument, string]>;
    expect(queued[0]?.[0]?.id).toBe('doc-newer');
    expect(queued[0]?.[0]?.modifiedAt).toBe(5000);
    // The queued snapshot carries the pinned blob ref so the replay can't orphan it.
    expect(queued[0]?.[0]?.blobReferences).toContain('hash-keep');
    expect(usePersistenceStore.getState().isAwaitingTeamLoad).toBe(false);
  });

  it('still overwrites when the relay copy is newer-or-equal (no unsynced local edit)', async () => {
    const localOlder = makeRelayDoc('doc-older');
    localOlder.modifiedAt = 1;
    saveDocumentToStorage(localOlder);

    const relayNewer = makeRelayDoc('doc-older');
    relayNewer.modifiedAt = 9000; // server moved ahead
    const loadRelayDocument = vi.fn(async () => relayNewer);
    useRelayDocumentStore.setState({ loadRelayDocument } as never);
    syncManagerMock.hasPendingChanges.mockReturnValue(false);
    usePersistenceStore.setState({
      currentDocumentId: 'doc-older',
      isAwaitingTeamLoad: true,
      teamDocContentPending: false,
    });

    await reattachAwaitingTeamDocument();

    expect(loadRelayDocument).toHaveBeenCalledWith('doc-older');
    // Relay copy wins → loaded into the editor, nothing queued.
    expect(syncManagerMock.queueSave).not.toHaveBeenCalled();
    expect(usePersistenceStore.getState().currentDocumentName).toBe('doc-older');
  });
});

describe('syncCurrentDocToRelayOnConnect — fire a versioned save on connect (JP-106 follow-up)', () => {
  beforeEach(() => {
    localStorage.clear();
    syncManagerMock.hasPendingChanges.mockReset();
    syncManagerMock.hasPendingChanges.mockReturnValue(false);
    useConnectionStore.getState().reset();
    useRelayDocumentStore.setState({ authenticated: false });
    usePersistenceStore.getState().reset();
  });

  function openDirtyRelayDoc(id: string, serverVersion: number) {
    // Hydrate the page store with a real doc, then point the store at a relay
    // doc id that exists in storage with a known serverVersion, marked dirty.
    usePersistenceStore.getState().newDocument('OnConnect');
    const stored = makeRelayDoc(id);
    stored.serverVersion = serverVersion;
    saveDocumentToStorage(stored);
    const saveToHost = vi.fn<[DiagramDocument, number?], Promise<{ newVersion: number }>>(
      async () => ({ newVersion: serverVersion + 1 }),
    );
    useRelayDocumentStore.setState({ authenticated: true, saveToHost } as never);
    usePersistenceStore.setState({
      currentDocumentId: id,
      isDirty: true,
      teamDocContentPending: false,
    });
    return saveToHost;
  }

  it('version-checked push of a dirty relay doc on connect', async () => {
    const saveToHost = openDirtyRelayDoc('doc-conn', 7);

    await syncCurrentDocToRelayOnConnect();

    expect(saveToHost).toHaveBeenCalledTimes(1);
    // Pushed with the known server version for the conflict check.
    expect(saveToHost.mock.calls[0]?.[1]).toBe(7);
    expect(usePersistenceStore.getState().isDirty).toBe(false);
  });

  it('surfaces a conflict toast and does not clear dirty when the server moved on', async () => {
    openDirtyRelayDoc('doc-conflict', 3);
    const saveToHost = vi.fn(async () => {
      throw new VersionConflictError('doc-conflict', 4);
    });
    useRelayDocumentStore.setState({ saveToHost } as never);
    const warning = vi.spyOn(useNotificationStore.getState(), 'warning');

    await syncCurrentDocToRelayOnConnect();

    expect(warning).toHaveBeenCalled();
    expect(usePersistenceStore.getState().isDirty).toBe(true);
  });

  it('no-ops when the doc is clean', async () => {
    const saveToHost = openDirtyRelayDoc('doc-clean', 1);
    usePersistenceStore.setState({ isDirty: false });

    await syncCurrentDocToRelayOnConnect();

    expect(saveToHost).not.toHaveBeenCalled();
  });

  it('defers to the queue when there are pending offline edits', async () => {
    const saveToHost = openDirtyRelayDoc('doc-queued', 1);
    syncManagerMock.hasPendingChanges.mockReturnValue(true);

    await syncCurrentDocToRelayOnConnect();

    expect(saveToHost).not.toHaveBeenCalled();
  });
});
