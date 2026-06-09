import { describe, it, expect, vi } from 'vitest';
import type { DocumentMetadata } from '../types/Document';

// Keep the import light: relayDocumentStore pulls in IndexedDB-backed deps.
vi.mock('../storage/RelayDocumentCache', () => ({
  RelayDocumentCache: {
    get: vi.fn(async () => null),
    put: vi.fn(async () => {}),
    has: vi.fn(() => false),
    getCachedIds: vi.fn(() => [] as string[]),
    getCachedIdsForHost: vi.fn(() => [] as string[]),
  },
}));
vi.mock('../collaboration/SyncStateManager', () => ({
  getSyncStateManager: () => ({ hasPendingChanges: () => false }),
}));

import { getEffectivePermission } from './relayDocumentStore';

function meta(over: Partial<DocumentMetadata>): DocumentMetadata {
  return { id: 'd', name: 'd', ...over } as DocumentMetadata;
}

describe('getEffectivePermission', () => {
  it('is owner when ownerId matches the user', () => {
    expect(getEffectivePermission(meta({ ownerId: 'u1' }), 'u1', undefined)).toBe('owner');
  });

  it('is owner for an UNOWNED doc in the user’s workspace (e.g. MCP-created)', () => {
    // The fix: a relay doc with no ownerId is the signed-in user's to manage, so
    // it gets the full action set instead of resolving to view-only.
    expect(getEffectivePermission(meta({}), 'u1', undefined)).toBe('owner');
  });

  it('is owner for an UNOWNED doc even when userId is not loaded', () => {
    // currentUser/userId mirrors the live-WS auth and is transiently undefined
    // while browsing (on a local doc / between sessions). An unowned doc must
    // still be ownable then — the bug was the `!userId` guard short-circuiting
    // to 'viewer' before the unowned check.
    expect(getEffectivePermission(meta({}), undefined, undefined)).toBe('owner');
  });

  it('is owner for an admin regardless of ownerId', () => {
    expect(getEffectivePermission(meta({ ownerId: 'someone-else' }), 'u1', 'admin')).toBe('owner');
  });

  it('is viewer for another user’s owned doc', () => {
    expect(getEffectivePermission(meta({ ownerId: 'u2' }), 'u1', undefined)).toBe('viewer');
  });

  it('respects an explicit edit share on an owned doc', () => {
    const shared = meta({
      ownerId: 'u2',
      sharedWith: [{ userId: 'u1', userName: 'U1', permission: 'edit' }],
    } as Partial<DocumentMetadata>);
    expect(getEffectivePermission(shared, 'u1', undefined)).toBe('editor');
  });

  it('is viewer for another user’s owned doc when no identity is loaded', () => {
    expect(getEffectivePermission(meta({ ownerId: 'u2' }), undefined, undefined)).toBe('viewer');
  });
});
