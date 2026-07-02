/**
 * JP-422 follow-up — opening a relay doc while offline.
 *
 * `docProvider` stays set on a mere disconnect, so it can't be the offline
 * signal; `loadRelayDocument` now treats `navigator.onLine === false` as
 * offline. Offline it (a) serves the persistent cache even if the relay's
 * metadata looks newer, and (b) never attempts a doomed network fetch — it
 * throws a typed error the open path turns into a friendly message.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cacheMock = vi.hoisted(() => ({
  get: vi.fn(async () => null as unknown),
  put: vi.fn(async () => {}),
  getCachedIdsForHost: vi.fn(() => [] as string[]),
  getMeta: vi.fn(() => null),
  remove: vi.fn(async () => {}),
}));

vi.mock('../storage/RelayDocumentCache', () => ({ RelayDocumentCache: cacheMock }));
vi.mock('../collaboration/SyncStateManager', () => ({
  getSyncStateManager: () => ({ hasPendingChanges: () => false }),
}));

import {
  useRelayDocumentStore,
  RelayDocumentUnavailableOfflineError,
  type DocumentProvider,
} from './relayDocumentStore';
import type { DiagramDocument } from '../types/Document';

function doc(id: string, modifiedAt: number): DiagramDocument {
  return {
    id,
    name: id,
    pages: { p1: { id: 'p1', name: 'P1', shapes: {}, shapeOrder: [], createdAt: 0, modifiedAt } },
    pageOrder: ['p1'],
    activePageId: 'p1',
    createdAt: 0,
    modifiedAt,
    version: 1,
  } as unknown as DiagramDocument;
}

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true });
}

const getDocument = vi.fn(async () => doc('d', 999));
const provider = { getDocument } as unknown as DocumentProvider;

describe('loadRelayDocument — offline open (JP-422)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheMock.get.mockResolvedValue(null);
    useRelayDocumentStore.setState({ documentCache: {}, relayDocuments: {}, loadingDocs: new Set() });
    useRelayDocumentStore.getState().setProvider(provider);
  });
  afterEach(() => setOnline(true));

  it('throws a typed error and does NOT fetch when offline and uncached', async () => {
    setOnline(false);
    await expect(useRelayDocumentStore.getState().loadRelayDocument('d')).rejects.toBeInstanceOf(
      RelayDocumentUnavailableOfflineError,
    );
    expect(getDocument).not.toHaveBeenCalled(); // no doomed network fetch
  });

  it('serves a STALE persistent cache when offline (beats failing to open)', async () => {
    // Relay metadata is newer than the cached copy → `isFresh` is false, so
    // online this would refetch. Offline it must still serve the local copy.
    useRelayDocumentStore.setState({ relayDocuments: { d: { modifiedAt: 500 } as never } });
    cacheMock.get.mockResolvedValue(doc('d', 100));
    setOnline(false);

    const loaded = await useRelayDocumentStore.getState().loadRelayDocument('d');
    expect(loaded.id).toBe('d');
    expect(getDocument).not.toHaveBeenCalled();
  });

  it('still fetches over the network when online and uncached (control)', async () => {
    setOnline(true);
    await useRelayDocumentStore.getState().loadRelayDocument('d');
    expect(getDocument).toHaveBeenCalledWith('d');
  });
});
