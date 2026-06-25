/**
 * Tests for `reconcileLocalDocuments` — the on-open / refresh reconcile that
 * heals the browser's local entries from the authoritative index without
 * clobbering relay-owned (remote/cached) entries or churning when nothing
 * changed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useDocumentRegistry,
  useActiveDocReadOnly,
  isActiveDocReadOnly,
} from './documentRegistry';
import { useConnectionStore } from './connectionStore';
import type { DocumentMetadata } from '../types/Document';

/** Unsigned JWT carrying a single `wsp[].id` — sets the active workspace for
 *  `activeWorkspaceId()` (which the registry stamps + filters on). */
function tokenForWs(id: string): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256' })}.${b64({ wsp: [{ id, role: 'owner' }] })}.sig`;
}

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
  useConnectionStore.getState().reset();
});

// JP-370: the browser is scoped to the active workspace — two workspaces on one
// relay host must not bleed into each other's list, and the registry persists
// every workspace's entries across switches.
describe('workspace scoping (JP-370)', () => {
  const RELAY = 'relay-shared:9876';

  it('getFilteredDocuments returns only the active workspace’s relay docs', () => {
    const r = useDocumentRegistry.getState();

    // Register doc-a while "in" workspace A, doc-b while in workspace B —
    // same relay host. registerRemote stamps the active workspace.
    useConnectionStore.getState().setToken(tokenForWs('ws-a'));
    r.registerRemote(meta('doc-a', 'A'), RELAY, 'owner', 'synced');
    useConnectionStore.getState().setToken(tokenForWs('ws-b'));
    r.registerRemote(meta('doc-b', 'B'), RELAY, 'owner', 'synced');

    // Active = B → only doc-b is listed (doc-a stays in the registry, hidden).
    const idsB = useDocumentRegistry.getState().getFilteredDocuments().map((d) => d.id);
    expect(idsB).toContain('doc-b');
    expect(idsB).not.toContain('doc-a');

    // Switch back to A → doc-a reappears, doc-b hidden. No re-fetch needed.
    useConnectionStore.getState().setToken(tokenForWs('ws-a'));
    const idsA = useDocumentRegistry.getState().getFilteredDocuments().map((d) => d.id);
    expect(idsA).toContain('doc-a');
    expect(idsA).not.toContain('doc-b');
  });

  it('records carry the workspace they were registered under', () => {
    useConnectionStore.getState().setToken(tokenForWs('ws-x'));
    useDocumentRegistry.getState().registerRemote(meta('d', 'D'), RELAY, 'owner', 'synced');
    const rec = useDocumentRegistry.getState().getRecord('d');
    expect(rec && 'workspaceId' in rec ? rec.workspaceId : null).toBe('ws-x');
  });
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

describe("resolveOriginRelayId ('unknown' heal — collab-idle badge)", () => {
  const relayIdOf = (id: string): string | undefined => {
    const rec = useDocumentRegistry.getState().getRecord(id);
    return rec && 'relayId' in rec ? rec.relayId : undefined;
  };

  it("adopts a real relayId over a stale 'unknown' origin on re-registration", () => {
    const r = useDocumentRegistry.getState();
    // Registered during a REST-only list fetch (connection.host was null).
    r.registerRemote(meta('d', 'Doc'), 'unknown', 'owner', 'synced');
    expect(relayIdOf('d')).toBe('unknown');

    // A later fetch, now that the relay identity is known, heals it — otherwise
    // the doc never matches the connected relay and its badge sticks on 'idle'.
    r.registerRemote(meta('d', 'Doc'), 'relay-a:9876', 'owner', 'synced');
    expect(relayIdOf('d')).toBe('relay-a:9876');
  });

  it('still preserves a real origin (never re-homes to a different connected relay)', () => {
    const r = useDocumentRegistry.getState();
    r.registerRemote(meta('d', 'Doc'), 'relay-a:9876', 'owner', 'synced');
    r.registerRemote(meta('d', 'Doc'), 'relay-b:9876', 'owner', 'synced');
    expect(relayIdOf('d')).toBe('relay-a:9876');
  });
});

// JP-370: the active doc is read-only iff it's a relay doc (remote/cached) on
// which this user holds only `viewer`. This selector is the single gate the
// editor's canvas + prose read-only UX hangs off, so the matrix is worth
// pinning — the relay is the real security guard, but a wrong answer here means
// a viewer makes edits that just get reverted (bad UX).
describe('useActiveDocReadOnly (JP-370)', () => {
  const readOnlyFor = (setup: () => string) => {
    const id = setup();
    useDocumentRegistry.getState().setActiveDocument(id);
    return renderHook(() => useActiveDocReadOnly()).result.current;
  };

  it('is true for a remote doc with viewer permission', () => {
    expect(
      readOnlyFor(() => {
        useDocumentRegistry.getState().registerRemote(meta('rv'), 'relay-a:9876', 'viewer', 'synced');
        return 'rv';
      }),
    ).toBe(true);
  });

  it('is true for a cached (offline) doc with viewer permission', () => {
    expect(
      readOnlyFor(() => {
        const r = useDocumentRegistry.getState();
        r.registerRemote(meta('cv'), 'relay-a:9876', 'viewer', 'synced');
        r.convertToCached('cv');
        return 'cv';
      }),
    ).toBe(true);
  });

  it('is false for a relay doc with editor or owner permission', () => {
    const r = useDocumentRegistry.getState();
    r.registerRemote(meta('re'), 'relay-a:9876', 'editor', 'synced');
    r.registerRemote(meta('ro'), 'relay-a:9876', 'owner', 'synced');
    r.setActiveDocument('re');
    expect(renderHook(() => useActiveDocReadOnly()).result.current).toBe(false);
    r.setActiveDocument('ro');
    expect(renderHook(() => useActiveDocReadOnly()).result.current).toBe(false);
  });

  it('is false for a local document (no viewer concept)', () => {
    expect(
      readOnlyFor(() => {
        useDocumentRegistry.getState().registerLocal(meta('local'));
        return 'local';
      }),
    ).toBe(false);
  });

  it('is false when no document is active', () => {
    useDocumentRegistry.getState().setActiveDocument(null);
    expect(renderHook(() => useActiveDocReadOnly()).result.current).toBe(false);
  });

  it('the non-hook isActiveDocReadOnly() agrees with the hook across the matrix', () => {
    const r = useDocumentRegistry.getState();
    r.registerRemote(meta('viewer'), 'relay-a:9876', 'viewer', 'synced');
    r.registerRemote(meta('editor'), 'relay-a:9876', 'editor', 'synced');
    r.registerLocal(meta('local'));

    for (const [id, expected] of [
      ['viewer', true],
      ['editor', false],
      ['local', false],
      [null, false],
    ] as const) {
      useDocumentRegistry.getState().setActiveDocument(id);
      const hook = renderHook(() => useActiveDocReadOnly()).result.current;
      expect(isActiveDocReadOnly()).toBe(expected);
      expect(isActiveDocReadOnly()).toBe(hook);
    }
  });
});
