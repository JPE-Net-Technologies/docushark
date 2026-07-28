/**
 * Tests for `isForeignRelayDoc` (JP-308) — the discriminant that flags a doc
 * belonging to a relay other than the one we're connected to. It gates both the
 * "Other relay" browser badge and the strand/demote guard, so getting it wrong
 * either wipes a doc's relay identity (false negative) or hides it (false
 * positive). Pure function → tested directly.
 */
import { describe, it, expect } from 'vitest';
import {
  isForeignRelayDoc,
  type LocalDocument,
  type RemoteDocument,
  type CachedDocument,
} from './DocumentRegistry';

const base = { id: 'd1', name: 'Doc', pageCount: 1, createdAt: 0, modifiedAt: 0 };

function remote(relayId: string): RemoteDocument {
  return {
    ...base,
    type: 'remote',
    relayId,
    workspaceId: 'ws-1',
    ownerId: 'u1',
    ownerName: 'User',
    permission: 'owner',
    syncState: 'synced',
    lastSyncedAt: 0,
  };
}

function cached(relayId: string): CachedDocument {
  return {
    ...base,
    type: 'cached',
    relayId,
    workspaceId: 'ws-1',
    originalDocId: 'd1',
    cachedAt: 0,
    pendingChanges: 0,
    permission: 'editor',
  };
}

const local: LocalDocument = { ...base, type: 'local' };

describe('isForeignRelayDoc', () => {
  it('is true for a remote doc whose relay differs from the connected one', () => {
    expect(isForeignRelayDoc(remote('relay-a:9876'), 'relay-b:9876')).toBe(true);
  });

  it('is true for a cached doc from another relay', () => {
    expect(isForeignRelayDoc(cached('relay-a:9876'), 'relay-b:9876')).toBe(true);
  });

  it('is false when the doc is on the connected relay', () => {
    expect(isForeignRelayDoc(remote('relay-a:9876'), 'relay-a:9876')).toBe(false);
  });

  it('is false when not connected to any relay (offline ≠ foreign)', () => {
    expect(isForeignRelayDoc(remote('relay-a:9876'), undefined)).toBe(false);
  });

  it("is false for an unknown-origin relay doc (can't prove it's foreign)", () => {
    expect(isForeignRelayDoc(remote('unknown'), 'relay-b:9876')).toBe(false);
  });

  it('is false for a local document', () => {
    expect(isForeignRelayDoc(local, 'relay-b:9876')).toBe(false);
  });
});

// JP-443: `sizeBytes` (the relay-recorded metered size) must survive every
// record conversion — including the cached round-trip an offline session
// takes — or the browser's Size detail silently vanishes.
describe('sizeBytes conversion carry (JP-443)', () => {
  it('carries through remote → cached → remote, and omits when absent', async () => {
    const { toRemoteDocument, toCachedDocument, toRemoteFromCached, toLocalDocument } =
      await import('./DocumentRegistry');
    const meta = { ...base, sizeBytes: 4096 };

    const rem = toRemoteDocument(meta, 'relay-a:9876', 'ws-1', 'owner');
    expect(rem.sizeBytes).toBe(4096);
    const cach = toCachedDocument(rem);
    expect(cach.sizeBytes).toBe(4096);
    expect(toRemoteFromCached(cach).sizeBytes).toBe(4096);
    expect(toLocalDocument(meta).sizeBytes).toBe(4096);

    // Absent stays absent (exactOptionalPropertyTypes: no `undefined` key).
    const bare = toRemoteDocument(base, 'relay-a:9876', 'ws-1', 'owner');
    expect('sizeBytes' in bare).toBe(false);
  });
});

// JP-444: owner + share metadata must survive the cached round-trip, or the
// People column and the "Shared with me" filter go blind after an offline
// spell (`toRemoteFromCached` used to blank the owner unconditionally).
describe('share metadata conversion carry (JP-444)', () => {
  it('carries owner, sharedWith, and lastModifiedByName through remote → cached → remote', async () => {
    const { toRemoteDocument, toCachedDocument, toRemoteFromCached } =
      await import('./DocumentRegistry');
    const shares = [{ userId: 'u2', userName: 'Bea', permission: 'edit' as const, sharedAt: 1 }];
    const meta = {
      ...base,
      ownerId: 'u1',
      ownerName: 'Ada',
      sharedWith: shares,
      lastModifiedByName: 'Bea',
    };

    const rem = toRemoteDocument(meta, 'relay-a:9876', 'ws-1', 'editor');
    expect(rem.sharedWith).toEqual(shares);
    expect(rem.lastModifiedByName).toBe('Bea');

    const cach = toCachedDocument(rem);
    expect(cach.ownerId).toBe('u1');
    expect(cach.ownerName).toBe('Ada');
    expect(cach.sharedWith).toEqual(shares);
    expect(cach.lastModifiedByName).toBe('Bea');

    const back = toRemoteFromCached(cach);
    expect(back.ownerId).toBe('u1');
    expect(back.ownerName).toBe('Ada');
    expect(back.sharedWith).toEqual(shares);
    expect(back.lastModifiedByName).toBe('Bea');
  });

  it('omits absent share metadata and never resurrects a blank owner', async () => {
    const { toRemoteDocument, toCachedDocument, toRemoteFromCached } =
      await import('./DocumentRegistry');
    const cach = toCachedDocument(toRemoteDocument(base, 'relay-a:9876', 'ws-1', 'owner'));
    expect('sharedWith' in cach).toBe(false);
    expect('lastModifiedByName' in cach).toBe(false);
    expect('ownerId' in cach).toBe(false);
    // Promoting an owner-less cache keeps the legacy blank-string sentinel.
    expect(toRemoteFromCached(cach).ownerId).toBe('');
  });
});
