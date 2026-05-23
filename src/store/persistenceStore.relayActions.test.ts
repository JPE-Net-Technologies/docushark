/**
 * Coverage for the relay-aware persistence actions added for JP-13 and
 * JP-14.
 *
 * - `createRelayDocumentAs(name)` (JP-13): mirrors `transferToTeam` but
 *   awaits the relay push so the UI can show success/failure inline.
 * - `renameDocumentById(docId, newName)` (JP-14): rename any doc (active
 *   or not, local or relay) with typed result for the conflict toast.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { usePersistenceStore, saveDocumentToStorage } from './persistenceStore';
import { useRelayDocumentStore } from './relayDocumentStore';
import type { DocumentProvider } from './relayDocumentStore';
import { useConnectionStore } from './connectionStore';
import { useUserStore } from './userStore';
import { VersionConflictError } from '../api/relayClient';
import type { DiagramDocument } from '../types/Document';

type ListDocsFn = () => Promise<unknown[]>;
type GetDocFn = (docId: string) => Promise<DiagramDocument>;
type SaveDocFn = (doc: DiagramDocument, expectedVersion?: number) => Promise<{ newVersion?: number } | void>;
type DeleteDocFn = (docId: string) => Promise<void>;

interface ProviderRecorder {
  listDocuments: ReturnType<typeof vi.fn<Parameters<ListDocsFn>, ReturnType<ListDocsFn>>>;
  getDocument: ReturnType<typeof vi.fn<Parameters<GetDocFn>, ReturnType<GetDocFn>>>;
  saveDocument: ReturnType<typeof vi.fn<Parameters<SaveDocFn>, ReturnType<SaveDocFn>>>;
  deleteDocument: ReturnType<typeof vi.fn<Parameters<DeleteDocFn>, ReturnType<DeleteDocFn>>>;
}

function installProvider(saveImpl?: SaveDocFn): ProviderRecorder {
  const provider: ProviderRecorder = {
    listDocuments: vi.fn<Parameters<ListDocsFn>, ReturnType<ListDocsFn>>(async () => []),
    getDocument: vi.fn<Parameters<GetDocFn>, ReturnType<GetDocFn>>(async () => {
      throw new Error('not used');
    }),
    saveDocument: vi.fn<Parameters<SaveDocFn>, ReturnType<SaveDocFn>>(
      saveImpl ?? (async () => ({ newVersion: 1 })),
    ),
    deleteDocument: vi.fn<Parameters<DeleteDocFn>, ReturnType<DeleteDocFn>>(async () => {}),
  };
  // Cast at the boundary; the mocks satisfy DocumentProvider structurally.
  useRelayDocumentStore.getState().setProvider(provider as unknown as DocumentProvider);
  useRelayDocumentStore.setState({ authenticated: true });
  useConnectionStore.setState({
    status: 'authenticated',
    host: { address: 'localhost:9876', url: 'http://localhost:9876' },
  });
  useUserStore.setState({
    currentUser: { id: 'user-1', username: 'test-user', displayName: 'Test User', role: 'admin' },
  });
  return provider;
}

function resetWorld(): void {
  localStorage.clear();
  useRelayDocumentStore.getState().setProvider(null);
  useRelayDocumentStore.setState({ authenticated: false, relayDocuments: {}, documentCache: {} });
  useConnectionStore.getState().reset();
  useUserStore.setState({ currentUser: null });
  usePersistenceStore.getState().reset();
  usePersistenceStore.getState().newDocument('Fresh');
}

describe('createRelayDocumentAs (JP-13)', () => {
  beforeEach(() => resetWorld());

  it('saves locally, marks isRelayDocument, and awaits the relay push', async () => {
    const provider = installProvider();

    const result = await usePersistenceStore.getState().createRelayDocumentAs('JP-13 happy');

    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow
    expect(provider.saveDocument).toHaveBeenCalledTimes(1);

    const savedArg = provider.saveDocument.mock.calls[0]?.[0] as DiagramDocument;
    expect(savedArg.isRelayDocument).toBe(true);
    expect(savedArg.ownerId).toBe('user-1');
    expect(savedArg.ownerName).toBe('Test User');

    const meta = usePersistenceStore.getState().documents[result.docId];
    expect(meta?.isRelayDocument).toBe(true);
  });

  it('returns ok:false with the relay error when saveToHost rejects', async () => {
    installProvider(async () => {
      throw new Error('Relay unreachable');
    });

    const result = await usePersistenceStore.getState().createRelayDocumentAs('JP-13 sad');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Relay unreachable');
  });

  it('returns ok:false without pushing when not authenticated', async () => {
    // No provider, no auth — local-only mode.
    const provider: ProviderRecorder = {
      listDocuments: vi.fn<Parameters<ListDocsFn>, ReturnType<ListDocsFn>>(),
      getDocument: vi.fn<Parameters<GetDocFn>, ReturnType<GetDocFn>>(),
      saveDocument: vi.fn<Parameters<SaveDocFn>, ReturnType<SaveDocFn>>(),
      deleteDocument: vi.fn<Parameters<DeleteDocFn>, ReturnType<DeleteDocFn>>(),
    };
    useRelayDocumentStore.getState().setProvider(provider as unknown as DocumentProvider);
    useRelayDocumentStore.setState({ authenticated: false });

    const result = await usePersistenceStore.getState().createRelayDocumentAs('offline');

    expect(result.ok).toBe(false);
    expect(provider.saveDocument).not.toHaveBeenCalled();
  });
});

describe('renameDocumentById (JP-14)', () => {
  beforeEach(() => resetWorld());

  it('delegates to renameDocument when docId is the active doc', async () => {
    usePersistenceStore.getState().saveDocument();
    const id = usePersistenceStore.getState().currentDocumentId!;
    const result = await usePersistenceStore.getState().renameDocumentById(id, 'Renamed Active');

    expect(result.ok).toBe(true);
    expect(usePersistenceStore.getState().currentDocumentName).toBe('Renamed Active');
    expect(usePersistenceStore.getState().documents[id]?.name).toBe('Renamed Active');
  });

  it('renames a non-active local doc without touching the relay', async () => {
    // Create two docs; the second becomes active, the first becomes the
    // rename target.
    usePersistenceStore.getState().saveDocument();
    const firstId = usePersistenceStore.getState().currentDocumentId!;
    usePersistenceStore.getState().newDocument('Second');
    usePersistenceStore.getState().saveDocument();

    // Auth + provider installed, but the target doc is NOT marked
    // isRelayDocument, so the relay path must be skipped.
    const provider = installProvider();

    const result = await usePersistenceStore.getState().renameDocumentById(firstId, 'Renamed Inactive');

    expect(result.ok).toBe(true);
    expect(usePersistenceStore.getState().documents[firstId]?.name).toBe('Renamed Inactive');
    expect(provider.saveDocument).not.toHaveBeenCalled();
  });

  it('pushes the renamed relay doc to the relay', async () => {
    // Promote the active doc to a relay doc, then create a second active
    // doc so the first is non-active.
    // Save the active doc to disk first so loadDocumentFromStorage finds it.
    usePersistenceStore.getState().saveDocument();
    const firstId = usePersistenceStore.getState().currentDocumentId!;
    const firstDoc = JSON.parse(localStorage.getItem(`docushark-doc-${firstId}`) ?? '{}') as DiagramDocument;
    firstDoc.isRelayDocument = true;
    firstDoc.serverVersion = 7;
    saveDocumentToStorage(firstDoc);

    usePersistenceStore.getState().newDocument('Second');
    usePersistenceStore.getState().saveDocument();

    const provider = installProvider();

    const result = await usePersistenceStore.getState().renameDocumentById(firstId, 'Renamed Relay');

    expect(result.ok).toBe(true);
    expect(provider.saveDocument).toHaveBeenCalledTimes(1);
    const [savedDoc, expectedVersion] = provider.saveDocument.mock.calls[0] ?? [];
    expect((savedDoc as DiagramDocument).name).toBe('Renamed Relay');
    expect(expectedVersion).toBe(7);
  });

  it('returns version-conflict when the relay rejects the save with 409', async () => {
    // Save the active doc to disk first so loadDocumentFromStorage finds it.
    usePersistenceStore.getState().saveDocument();
    const firstId = usePersistenceStore.getState().currentDocumentId!;
    const firstDoc = JSON.parse(localStorage.getItem(`docushark-doc-${firstId}`) ?? '{}') as DiagramDocument;
    firstDoc.isRelayDocument = true;
    firstDoc.serverVersion = 3;
    saveDocumentToStorage(firstDoc);

    usePersistenceStore.getState().newDocument('Second');
    usePersistenceStore.getState().saveDocument();

    installProvider(async () => {
      throw new VersionConflictError('/api/docs/x', 5);
    });

    const result = await usePersistenceStore.getState().renameDocumentById(firstId, 'Conflicting');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('version-conflict');
  });

  it('returns not-found when the doc id does not exist', async () => {
    installProvider();
    const result = await usePersistenceStore.getState().renameDocumentById('ghost-id', 'whatever');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-found');
  });
});
