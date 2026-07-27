/**
 * The editor's permission mirror, pinned to the relay's own table (JP-458).
 *
 * The matrix block below reads `relay/tests/fixtures/permission-matrix.json` —
 * the *same* file the Rust resolver's unit test iterates
 * (`relay/src/server/permissions.rs::matrix_fixture_matches_the_resolver`).
 * Same idea as `src/collaboration/protocol.fixtures.test.ts`, which shares
 * `relay/tests/protocol-fixtures/` with `protocol.rs`.
 *
 * Why it exists: client and relay had silently diverged in both directions.
 * `getEffectivePermission` fell through to `'viewer'` where the relay grants
 * nothing, so the editor offered documents the server refused; and it granted
 * on `userRole === 'admin'`, a value the relay has never sent, so every
 * workspace owner was under-privileged in the UI. Neither was caught, because
 * nothing compared the two implementations. Now a change to either side that
 * isn't mirrored fails here or in Rust.
 *
 * Cases whose principal is not a `user` are Rust-only — the editor is always an
 * authenticated user and has no service or anonymous principal to model.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const MATRIX_PATH = resolve(__dirname, '../../relay/tests/fixtures/permission-matrix.json');

interface MatrixCase {
  name: string;
  enforce: boolean;
  principal:
    | { kind: 'service' | 'anonymous' }
    | { kind: 'user'; userId: string; workspaceRole: string };
  document: {
    ownerId: string | null;
    sharedWith: Array<{ userId: string; permission: string }>;
  };
  expect: 'owner' | 'editor' | 'viewer' | 'none';
}

function meta(over: Partial<DocumentMetadata>): DocumentMetadata {
  return { id: 'd', name: 'd', ...over } as DocumentMetadata;
}

function fromMatrix(doc: MatrixCase['document']): DocumentMetadata {
  return meta({
    ...(doc.ownerId !== null ? { ownerId: doc.ownerId } : {}),
    sharedWith: doc.sharedWith.map((s) => ({
      userId: s.userId,
      userName: s.userId,
      permission: s.permission,
    })),
  } as Partial<DocumentMetadata>);
}

describe('getEffectivePermission — the shared relay matrix', () => {
  const raw = JSON.parse(readFileSync(MATRIX_PATH, 'utf8')) as { cases: MatrixCase[] };
  const userCases = raw.cases.filter((c) => c.principal.kind === 'user');

  it('loads a meaningful number of user cases', () => {
    // Guards the filter and the file itself: a green run over zero cases would
    // prove nothing, and would look identical to a passing suite.
    expect(userCases.length).toBeGreaterThanOrEqual(10);
  });

  for (const testCase of userCases) {
    const principal = testCase.principal as {
      kind: 'user';
      userId: string;
      workspaceRole: string;
    };

    it(testCase.name, () => {
      // `enforce` is a server deployment setting the client has no view of. A
      // relay with enforcement off is *more* permissive than this mirror
      // predicts, which is the safe direction — the editor never offers an
      // action the server would refuse. So the enforcement-off rows are
      // asserted against what the client computes, which is the enforced
      // answer; only the direction of the difference matters.
      const actual = getEffectivePermission(
        fromMatrix(testCase.document),
        principal.userId,
        principal.workspaceRole,
      );

      if (testCase.enforce) {
        expect(actual).toBe(testCase.expect);
      } else {
        // Never more permissive than the relay would be.
        const rank = { none: 0, viewer: 1, editor: 2, owner: 3 } as const;
        expect(rank[actual]).toBeLessThanOrEqual(rank[testCase.expect]);
      }
    });
  }
});

describe('getEffectivePermission — client-specific behaviour', () => {
  it('is owner when ownerId matches the user', () => {
    expect(getEffectivePermission(meta({ ownerId: 'u1' }), 'u1', undefined)).toBe('owner');
  });

  it('grants nothing on another user’s unshared document', () => {
    // Previously 'viewer' — the client claimed read access the relay refuses.
    expect(getEffectivePermission(meta({ ownerId: 'u2' }), 'u1', 'member')).toBe('none');
  });

  it('respects an explicit edit share', () => {
    const shared = meta({
      ownerId: 'u2',
      sharedWith: [{ userId: 'u1', userName: 'U1', permission: 'edit' }],
    } as Partial<DocumentMetadata>);
    expect(getEffectivePermission(shared, 'u1', 'member')).toBe('editor');
  });

  it('caps a workspace viewer’s edit share at read-only', () => {
    const shared = meta({
      ownerId: 'u2',
      sharedWith: [{ userId: 'u1', userName: 'U1', permission: 'edit' }],
    } as Partial<DocumentMetadata>);
    expect(getEffectivePermission(shared, 'u1', 'viewer')).toBe('viewer');
  });

  it('treats an unowned document as editable (the relay’s legacy carve-out)', () => {
    expect(getEffectivePermission(meta({}), 'u1', 'member')).toBe('editor');
  });

  describe('when identity has not loaded yet', () => {
    // Reachable, not hypothetical: `currentUser` mirrors the WebSocket auth
    // state while the document list is fetched over REST with a stored token,
    // so a boot can list documents before connecting. Resolving to 'none' here
    // would mark every document inaccessible and flip the editor read-only.

    it('falls back to read access, because the relay pre-filtered the listing', () => {
      expect(getEffectivePermission(meta({ ownerId: 'u2' }), undefined, undefined)).toBe('viewer');
    });

    it('keeps an unowned document editable', () => {
      expect(getEffectivePermission(meta({}), undefined, undefined)).toBe('editor');
    });
  });

  describe('role spellings', () => {
    const doc = meta({ ownerId: 'alice' });

    it('accepts the legacy admin role as workspace owner', () => {
      // Lets this ship independently of the relay's role-spelling fix, rather
      // than depending on deploy order.
      expect(getEffectivePermission(doc, 'bob', 'admin')).toBe('owner');
    });

    it('accepts the legacy user role as plain membership', () => {
      expect(getEffectivePermission(doc, 'bob', 'user')).toBe('none');
    });

    it('grants nothing for an unrecognised role', () => {
      expect(getEffectivePermission(doc, 'bob', 'wizard')).toBe('none');
    });
  });
});
