import { describe, it, expect } from 'vitest';
import { computeSharedDocOffline } from './sharedDocOffline';

// A relay doc identified by an active collab session, currently online.
const onlineRelay = {
  currentDocId: 'doc-1',
  collabDocId: 'doc-1',
  collabActive: true,
  recordType: undefined,
  status: 'authenticated' as const,
};

describe('computeSharedDocOffline (JP-334)', () => {
  it('is false when there is no open document', () => {
    expect(computeSharedDocOffline({ ...onlineRelay, currentDocId: null })).toBe(false);
  });

  it('is false for a local-only doc, even disconnected', () => {
    expect(
      computeSharedDocOffline({
        currentDocId: 'doc-1',
        collabDocId: null,
        collabActive: false,
        recordType: 'local',
        status: 'disconnected',
      }),
    ).toBe(false);
  });

  it('is false for a relay doc that is fully connected (authenticated)', () => {
    expect(computeSharedDocOffline(onlineRelay)).toBe(false);
  });

  it('is true for a relay doc (active session) that is not yet authenticated', () => {
    for (const status of ['disconnected', 'connecting', 'connected', 'authenticating', 'error'] as const) {
      expect(computeSharedDocOffline({ ...onlineRelay, status })).toBe(true);
    }
  });

  it('is true for a relay doc identified by registry record type when offline', () => {
    expect(
      computeSharedDocOffline({
        currentDocId: 'doc-1',
        collabDocId: null,
        collabActive: false,
        recordType: 'remote',
        status: 'connecting',
      }),
    ).toBe(true);
  });
});
