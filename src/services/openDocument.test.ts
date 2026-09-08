/**
 * `openDocumentById` is shared by the document browser and the palette's
 * quick-open. It was extracted from a hook-bound callback so there would be one
 * implementation rather than two drifting ones, which makes its behaviour worth
 * pinning: a regression here breaks two surfaces at once.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { openDocumentById } from './openDocument';
import { useDocumentRegistry } from '../store/documentRegistry';
import { usePersistenceStore } from '../store/persistenceStore';
import { useRelayDocumentStore, RelayDocumentUnavailableOfflineError } from '../store/relayDocumentStore';
import { useNotificationStore } from '../store/notificationStore';

function seedRegistry(id: string, type: 'local' | 'remote' | 'cached') {
  useDocumentRegistry.setState({
    entries: { [id]: { record: { id, name: id, type } as never, isLoading: false } },
  } as never);
}

describe('openDocumentById', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useDocumentRegistry.setState({ entries: {} } as never);
  });

  it('loads a local document through the persistence store', async () => {
    seedRegistry('local-1', 'local');
    const loadDocument = vi.fn(() => true);
    usePersistenceStore.setState({ currentDocumentId: 'other', loadDocument } as never);

    await openDocumentById('local-1');

    expect(loadDocument).toHaveBeenCalledWith('local-1');
  });

  it('is a no-op when the document is already open', async () => {
    // Re-opening the current document would tear down and rebuild a live
    // session for no reason.
    seedRegistry('doc-1', 'local');
    const loadDocument = vi.fn(() => true);
    usePersistenceStore.setState({ currentDocumentId: 'doc-1', loadDocument } as never);

    await openDocumentById('doc-1');

    expect(loadDocument).not.toHaveBeenCalled();
  });

  it('is a no-op for an id the registry does not know', async () => {
    const loadDocument = vi.fn(() => true);
    usePersistenceStore.setState({ currentDocumentId: null, loadDocument } as never);

    await openDocumentById('ghost');

    expect(loadDocument).not.toHaveBeenCalled();
  });

  it('loads a relay document over the network, then hands it to persistence', async () => {
    seedRegistry('remote-1', 'remote');
    const doc = { id: 'remote-1' };
    const loadRelayDocument = vi.fn(async () => doc);
    const loadRemoteDocument = vi.fn();
    useRelayDocumentStore.setState({ loadRelayDocument } as never);
    usePersistenceStore.setState({ currentDocumentId: null, loadRemoteDocument } as never);

    await openDocumentById('remote-1');

    expect(loadRelayDocument).toHaveBeenCalledWith('remote-1');
    expect(loadRemoteDocument).toHaveBeenCalledWith(doc);
  });

  it('treats a cached document as relay-backed, not local', async () => {
    seedRegistry('cached-1', 'cached');
    const loadRelayDocument = vi.fn(async () => ({ id: 'cached-1' }));
    useRelayDocumentStore.setState({ loadRelayDocument } as never);
    usePersistenceStore.setState({ currentDocumentId: null, loadRemoteDocument: vi.fn() } as never);

    await openDocumentById('cached-1');

    expect(loadRelayDocument).toHaveBeenCalled();
  });

  it('reports an OFFLINE failure with the advice that fixes it', async () => {
    // "You are offline" and "that did not work" need different actions from the
    // user, so they must not collapse into one message.
    seedRegistry('remote-1', 'remote');
    useRelayDocumentStore.setState({
      loadRelayDocument: vi.fn(async () => {
        throw new RelayDocumentUnavailableOfflineError('nope');
      }),
    } as never);
    usePersistenceStore.setState({ currentDocumentId: null, loadRemoteDocument: vi.fn() } as never);
    const warning = vi.fn();
    useNotificationStore.setState({ warning } as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await openDocumentById('remote-1');

    expect(warning).toHaveBeenCalledTimes(1);
    expect(String(warning.mock.calls[0]?.[0])).toContain('available offline');
  });

  it('reports a generic failure differently', async () => {
    seedRegistry('remote-1', 'remote');
    useRelayDocumentStore.setState({
      loadRelayDocument: vi.fn(async () => {
        throw new Error('500');
      }),
    } as never);
    usePersistenceStore.setState({ currentDocumentId: null, loadRemoteDocument: vi.fn() } as never);
    const warning = vi.fn();
    useNotificationStore.setState({ warning } as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await openDocumentById('remote-1');

    expect(String(warning.mock.calls[0]?.[0])).toContain('Check your connection');
  });

  it('never rejects — callers are UI affordances with nothing to do with a throw', async () => {
    seedRegistry('remote-1', 'remote');
    useRelayDocumentStore.setState({
      loadRelayDocument: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as never);
    usePersistenceStore.setState({ currentDocumentId: null, loadRemoteDocument: vi.fn() } as never);
    useNotificationStore.setState({ warning: vi.fn() } as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(openDocumentById('remote-1')).resolves.toBeUndefined();
  });
});
