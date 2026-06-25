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
