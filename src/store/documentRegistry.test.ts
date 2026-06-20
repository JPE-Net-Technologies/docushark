/**
 * Tests for `reconcileLocalDocuments` — the on-open / refresh reconcile that
 * heals the browser's local entries from the authoritative index without
 * clobbering relay-owned (remote/cached) entries or churning when nothing
 * changed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useDocumentRegistry } from './documentRegistry';
import type { DocumentMetadata } from '../types/Document';

function meta(id: string, name = 'Doc', isRelayDocument = false): DocumentMetadata {
  return {
    id,
    name,
    pageCount: 1,
    createdAt: 0,
    modifiedAt: 0,
    ...(isRelayDocument ? { isRelayDocument: true } : {}),
  };
}

beforeEach(() => {
  useDocumentRegistry.getState().reset();
});

describe('reconcileLocalDocuments', () => {
  it('upserts a new local doc as a local record', () => {
    useDocumentRegistry.getState().reconcileLocalDocuments([meta('a', 'Alpha')]);
    const rec = useDocumentRegistry.getState().getRecord('a');
    expect(rec?.type).toBe('local');
    expect(rec?.name).toBe('Alpha');
  });

  it('refreshes a changed name on an existing local entry', () => {
    const r = useDocumentRegistry.getState();
    r.registerLocal(meta('a', 'Old'));
    r.reconcileLocalDocuments([meta('a', 'New')]);
    expect(useDocumentRegistry.getState().getRecord('a')?.name).toBe('New');
  });

  it('does not clobber an existing remote entry with the same id (no demote)', () => {
    const r = useDocumentRegistry.getState();
    r.registerRemote(meta('a', 'Remote'), 'relay-a:9876', 'owner', 'synced');
    // The local index still lists it (e.g. mirrored) as a non-relay meta.
    r.reconcileLocalDocuments([meta('a', 'Stale Local')]);
    const rec = useDocumentRegistry.getState().getRecord('a');
    expect(rec?.type).toBe('remote'); // stayed remote, not demoted to local
    expect(rec?.name).toBe('Remote');
  });

  it('ignores relay-flagged metas', () => {
    useDocumentRegistry.getState().reconcileLocalDocuments([meta('a', 'Relay', true)]);
    expect(useDocumentRegistry.getState().getRecord('a')).toBeUndefined();
  });

  it('no-ops (keeps entries identity) when nothing changed', () => {
    const r = useDocumentRegistry.getState();
    r.registerLocal(meta('a', 'Same'));
    const before = useDocumentRegistry.getState().entries;
    r.reconcileLocalDocuments([meta('a', 'Same')]);
    expect(useDocumentRegistry.getState().entries).toBe(before);
  });
});

describe('clearRemoteDocuments (JP-324 hard-disconnect keeps cached docs)', () => {
  const RELAY = 'relay-a:9876';
  const OTHER = 'relay-b:9876';

  function getType(id: string) {
    return useDocumentRegistry.getState().getRecord(id)?.type;
  }

  it('demotes an offline-available remote doc to cached instead of dropping it', () => {
    const r = useDocumentRegistry.getState();
    r.registerRemote(meta('keep', 'Keep'), RELAY, 'owner', 'synced');
    r.registerRemote(meta('drop', 'Drop'), RELAY, 'owner', 'synced');

    // Only 'keep' has an offline copy.
    r.clearRemoteDocuments(RELAY, new Set(['keep']));

    expect(getType('keep')).toBe('cached'); // demoted, still browsable offline
    expect(getType('drop')).toBeUndefined(); // no offline copy → dropped
  });

  it('keeps an already-cached doc that is offline-available', () => {
    const r = useDocumentRegistry.getState();
    r.registerRemote(meta('c', 'Cached'), RELAY, 'owner', 'synced');
    r.convertToCached('c');
    expect(getType('c')).toBe('cached');

    r.clearRemoteDocuments(RELAY, new Set(['c']));

    expect(getType('c')).toBe('cached');
  });

  it('leaves docs from a different relay untouched', () => {
    const r = useDocumentRegistry.getState();
    r.registerRemote(meta('other', 'Other'), OTHER, 'owner', 'synced');

    r.clearRemoteDocuments(RELAY, new Set());

    expect(getType('other')).toBe('remote');
  });

  it('keeps local documents', () => {
    const r = useDocumentRegistry.getState();
    r.registerLocal(meta('loc', 'Local'));

    r.clearRemoteDocuments(RELAY, new Set());

    expect(getType('loc')).toBe('local');
  });

  it('drops everything for the relay when no preserve set is given (legacy purge)', () => {
    const r = useDocumentRegistry.getState();
    r.registerRemote(meta('x', 'X'), RELAY, 'owner', 'synced');
    r.registerRemote(meta('y', 'Y'), RELAY, 'owner', 'synced');

    r.clearRemoteDocuments(RELAY);

    expect(getType('x')).toBeUndefined();
    expect(getType('y')).toBeUndefined();
  });
});
