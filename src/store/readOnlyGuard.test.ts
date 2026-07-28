/**
 * The fail-closed read-only guard (JP-464).
 *
 * Every read-only enforcement point in the app (Engine, CommandRegistry, both
 * prose editors, the toolbars) resolves through `isActiveDocReadOnly` /
 * `useActiveDocReadOnly`. These tests pin the guard's shape:
 *
 * - an ACTIVE id with no registry record is READ-ONLY (the guest invariant —
 *   before JP-464 this arm failed open, and a guest document would have
 *   rendered fully editable);
 * - `external` records are read-only by allowlist omission, not by naming;
 * - the null-active state stays editable (a fresh scratch document is only
 *   registered on first save — flipping this arm breaks new-document flow).
 *
 * Mutation check (verification step): revert either arm and the named test
 * here fails.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { isActiveDocReadOnly, useDocumentRegistry } from './documentRegistry';
import type { ExternalDocument } from '../types/DocumentRegistry';

function externalRecord(id: string): ExternalDocument {
  return {
    type: 'external',
    source: 'share-link',
    id,
    name: 'Guest Doc',
    pageCount: 1,
    createdAt: 1,
    modifiedAt: 1,
  };
}

beforeEach(() => {
  useDocumentRegistry.setState({ entries: {}, activeDocumentId: null });
});

describe('isActiveDocReadOnly (fail-closed, JP-464)', () => {
  it('no active document → editable (the unsaved scratch doc)', () => {
    expect(isActiveDocReadOnly()).toBe(false);
  });

  it('an active id WITHOUT a registry record → read-only (the guest invariant)', () => {
    useDocumentRegistry.setState({ activeDocumentId: 'ghost-doc' });
    expect(isActiveDocReadOnly()).toBe(true);
  });

  it('an external (share-link) record → read-only', () => {
    useDocumentRegistry.getState().registerExternal(externalRecord('guest-1'));
    useDocumentRegistry.getState().setActiveDocument('guest-1');
    expect(isActiveDocReadOnly()).toBe(true);
  });

  it('regression: local docs and remote editors stay editable; remote viewers do not', () => {
    const base = { id: 'd', name: 'D', pageCount: 1, createdAt: 1, modifiedAt: 1 };
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ ...base, type: 'local' }, false],
      [
        {
          ...base,
          type: 'remote',
          relayId: 'r',
          workspaceId: 'w',
          ownerId: 'o',
          ownerName: 'O',
          permission: 'editor',
          syncState: 'synced',
          lastSyncedAt: 1,
        },
        false,
      ],
      [
        {
          ...base,
          type: 'remote',
          relayId: 'r',
          workspaceId: 'w',
          ownerId: 'o',
          ownerName: 'O',
          permission: 'viewer',
          syncState: 'synced',
          lastSyncedAt: 1,
        },
        true,
      ],
      [
        {
          ...base,
          type: 'remote',
          relayId: 'r',
          workspaceId: 'w',
          ownerId: 'o',
          ownerName: 'O',
          permission: 'none',
          syncState: 'synced',
          lastSyncedAt: 1,
        },
        true,
      ],
    ];
    for (const [record, expected] of cases) {
      useDocumentRegistry.setState({
        entries: {
          d: { record: record as never, isLoading: false },
        },
        activeDocumentId: 'd',
      });
      expect(isActiveDocReadOnly(), `${String(record['type'])}/${String(record['permission'])}`).toBe(expected);
    }
  });

  it('external records never reach the persisted snapshot', () => {
    // Caught live: the registry's persist middleware serialized the guest
    // record wholesale, leaving a "Shared with you" ghost in the visitor's
    // localStorage across sessions. Session-only means session-only.
    useDocumentRegistry.getState().registerExternal(externalRecord('guest-persist'));
    const partialize = useDocumentRegistry.persist.getOptions().partialize!;
    const snapshot = partialize(useDocumentRegistry.getState()) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(snapshot.entries)).not.toContain('guest-persist');
  });

  it('external records never surface in browser listings', () => {
    useDocumentRegistry.getState().registerExternal(externalRecord('guest-2'));
    const listed = useDocumentRegistry
      .getState()
      .getFilteredDocuments()
      .map((r) => r.id);
    expect(listed).not.toContain('guest-2');
  });
});
