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
