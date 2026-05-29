/**
 * Tests for the relay-labelling helpers used by the document browser to
 * differentiate documents across relays (connected vs disconnected) and to
 * bucket them under "By relay" grouping.
 */

import { formatRelayLabel, getRelayId } from './DocumentCard';
import { relayKeyForRecord } from './settings/DocumentBrowser';
import type {
  LocalDocument,
  RemoteDocument,
  CachedDocument,
} from '../types/DocumentRegistry';

const base = { name: 'Doc', pageCount: 1, createdAt: 0, modifiedAt: 0 };

const local: LocalDocument = { type: 'local', id: 'l1', ...base };

const remote: RemoteDocument = {
  type: 'remote',
  id: 'r1',
  ...base,
  relayId: 'localhost:9876',
  ownerId: 'u1',
  ownerName: 'Alice',
  permission: 'owner',
  syncState: 'synced',
  lastSyncedAt: 0,
};

const cached: CachedDocument = {
  type: 'cached',
  id: 'c1',
  ...base,
  relayId: 'office.example:9876',
  originalDocId: 'r2',
  cachedAt: 0,
  pendingChanges: 0,
  permission: 'editor',
};

const unknownRemote: RemoteDocument = { ...remote, id: 'r3', relayId: 'unknown' };

describe('getRelayId', () => {
  it('returns undefined for local documents', () => {
    expect(getRelayId(local)).toBeUndefined();
  });

  it('returns the relayId for remote and cached documents', () => {
    expect(getRelayId(remote)).toBe('localhost:9876');
    expect(getRelayId(cached)).toBe('office.example:9876');
  });
});

describe('formatRelayLabel', () => {
  it('returns undefined for local documents (no relay badge)', () => {
    expect(formatRelayLabel(local, 'localhost:9876')).toBeUndefined();
  });

  it('marks a document connected when its relayId matches the connected address', () => {
    expect(formatRelayLabel(remote, 'localhost:9876')).toEqual({
      host: 'localhost:9876',
      status: 'connected',
    });
  });

  it('marks a document disconnected when the relay differs', () => {
    expect(formatRelayLabel(cached, 'localhost:9876')).toEqual({
      host: 'office.example:9876',
      status: 'disconnected',
    });
  });

  it('marks a document disconnected when nothing is connected', () => {
    expect(formatRelayLabel(remote, undefined)).toEqual({
      host: 'localhost:9876',
      status: 'disconnected',
    });
  });

  it("treats 'unknown' relays as disconnected even if connected address is also 'unknown'", () => {
    expect(formatRelayLabel(unknownRemote, 'unknown')).toEqual({
      host: 'Unknown relay',
      status: 'disconnected',
    });
  });
});

describe('relayKeyForRecord', () => {
  it('buckets local documents under the local key', () => {
    expect(relayKeyForRecord(local)).toBe('__local__');
  });

  it('buckets remote/cached documents under their relayId', () => {
    expect(relayKeyForRecord(remote)).toBe('localhost:9876');
    expect(relayKeyForRecord(cached)).toBe('office.example:9876');
  });

  it("buckets relayId-less remote docs under 'unknown'", () => {
    expect(relayKeyForRecord({ ...remote, relayId: '' })).toBe('unknown');
  });
});
