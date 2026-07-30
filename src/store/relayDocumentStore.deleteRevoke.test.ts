/**
 * JP-470 — deleting a relay document darkens its public share link.
 *
 * The revoke lives in `deleteFromHost` ONLY: it is the single choke point
 * every delete path funnels through (trash, document browser, transfer to
 * personal), so no caller carries its own revoke and none can double-fire.
 * Ordering is the contract — row first (mirroring unpublish: the URL dies
 * even if later steps fail), relay delete second — and a revoke failure must
 * never block the delete (the relay's own artifact teardown keeps readers
 * dark; the row is the tidiness half).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];

const webMock = vi.hoisted(() => ({ revokeShareLink: vi.fn() }));
vi.mock('../api/webClient', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api/webClient')>();
  return {
    ...original,
    webClient: new Proxy(original.webClient, {
      get(target, prop: string) {
        if (prop === 'revokeShareLink') {
          return (...args: unknown[]) => {
            calls.push('revoke');
            return webMock.revokeShareLink(...args);
          };
        }
        return (target as Record<string, unknown>)[prop];
      },
    }),
  };
});

const cacheMock = vi.hoisted(() => ({
  get: vi.fn(async () => null as unknown),
  put: vi.fn(async () => {}),
  getCachedIdsForHost: vi.fn(() => [] as string[]),
  getMeta: vi.fn(() => null),
  remove: vi.fn(async () => {}),
}));
vi.mock('../storage/RelayDocumentCache', () => ({ RelayDocumentCache: cacheMock }));

import { useRelayDocumentStore, type DocumentProvider } from './relayDocumentStore';

describe('deleteFromHost share-link revoke (JP-470)', () => {
  beforeEach(() => {
    calls.length = 0;
    webMock.revokeShareLink.mockReset().mockResolvedValue(undefined);
    useRelayDocumentStore.getState().setProvider(null);
  });

  it('revokes the row BEFORE the relay delete', async () => {
    const provider = {
      deleteDocument: vi.fn(async () => {
        calls.push('relay-delete');
      }),
    } as unknown as DocumentProvider;
    useRelayDocumentStore.getState().setProvider(provider);

    await useRelayDocumentStore.getState().deleteFromHost('doc-a');

    expect(calls).toEqual(['revoke', 'relay-delete']);
  });

  it('a revoke failure never blocks the delete (relay teardown covers readers)', async () => {
    webMock.revokeShareLink.mockRejectedValue(new Error('control plane down'));
    const provider = {
      deleteDocument: vi.fn(async () => {
        calls.push('relay-delete');
      }),
    } as unknown as DocumentProvider;
    useRelayDocumentStore.getState().setProvider(provider);

    await useRelayDocumentStore.getState().deleteFromHost('doc-a');

    expect(calls).toEqual(['revoke', 'relay-delete']);
  });

  it('a relay-delete failure still surfaces (and the revoke already fired)', async () => {
    const provider = {
      deleteDocument: vi.fn(async () => {
        throw new Error('forbidden');
      }),
    } as unknown as DocumentProvider;
    useRelayDocumentStore.getState().setProvider(provider);

    await expect(useRelayDocumentStore.getState().deleteFromHost('doc-a')).rejects.toThrow(
      'forbidden',
    );
    expect(calls).toEqual(['revoke']);
  });
});
