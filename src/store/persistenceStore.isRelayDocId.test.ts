/**
 * isRelayDocId (JP boot auto-sign-in): classify a doc as relay/cloud via the
 * durable `isRelayDocument` metadata flag (primary) or a registry `remote` record.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { isRelayDocId, usePersistenceStore } from './persistenceStore';
import { useDocumentRegistry } from './documentRegistry';
import type { DocumentMetadata } from '../types/Document';

function meta(id: string, isRelayDocument = false): DocumentMetadata {
  return {
    id,
    name: id,
    createdAt: 0,
    modifiedAt: 0,
    ...(isRelayDocument ? { isRelayDocument: true } : {}),
  } as DocumentMetadata;
}

describe('isRelayDocId', () => {
  beforeEach(() => {
    usePersistenceStore.setState({ documents: {} } as never);
    useDocumentRegistry.getState().reset();
  });

  it('false for null or an unknown id', () => {
    expect(isRelayDocId(null)).toBe(false);
    expect(isRelayDocId('nope')).toBe(false);
  });

  it('true via the durable isRelayDocument metadata flag', () => {
    usePersistenceStore.setState({ documents: { d: meta('d', true) } } as never);
    expect(isRelayDocId('d')).toBe(true);
  });

  it('false for a plain local doc', () => {
    usePersistenceStore.setState({ documents: { l: meta('l', false) } } as never);
    expect(isRelayDocId('l')).toBe(false);
  });

  it('true via a registry remote record', () => {
    useDocumentRegistry.getState().registerRemote(meta('r'), 'relay-a:9876', 'owner', 'synced');
    expect(isRelayDocId('r')).toBe(true);
  });
});
