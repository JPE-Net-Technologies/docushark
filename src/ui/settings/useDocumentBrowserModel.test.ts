/**
 * Pure-logic coverage for the document-browser model (JP-218 extraction).
 *
 * The hook itself wires many zustand stores together (covered by manual /
 * integration testing), but the sort comparator, permission gates, and
 * transfer-error mapping it exports are pure and worth pinning — they decide
 * ordering and which per-card affordances appear.
 */

import { describe, it, expect } from 'vitest';
import {
  compareRecords,
  friendlyTransferError,
  isSharedWithMe,
  canDelete,
  canEdit,
  canManagePermissions,
  canPublishToRelay,
  canMoveToPersonal,
  buildGroupedSections,
  UNASSIGNED_KEY,
} from './useDocumentBrowserModel';
import type { DocumentRecord } from '../../types/DocumentRegistry';
import type { Collection } from '../../store/collectionStore';

/** Minimal record shape — the helpers only read these fields. */
function rec(partial: Partial<DocumentRecord>): DocumentRecord {
  return {
    id: 'd',
    name: 'Doc',
    type: 'local',
    createdAt: 0,
    modifiedAt: 0,
    ...partial,
  } as DocumentRecord;
}

describe('compareRecords', () => {
  const older = rec({ id: 'a', name: 'Alpha', createdAt: 100, modifiedAt: 100 });
  const newer = rec({ id: 'b', name: 'Bravo', createdAt: 200, modifiedAt: 200 });

  it('modified-desc puts most-recently-modified first', () => {
    expect(compareRecords(older, newer, 'modified-desc')).toBeGreaterThan(0);
    expect(compareRecords(newer, older, 'modified-desc')).toBeLessThan(0);
  });

  it('modified-asc reverses that', () => {
    expect(compareRecords(older, newer, 'modified-asc')).toBeLessThan(0);
  });

  it('created-desc orders by createdAt', () => {
    expect(compareRecords(older, newer, 'created-desc')).toBeGreaterThan(0);
  });

  it('name-asc / name-desc order case-insensitively', () => {
    const lower = rec({ name: 'apple' });
    const upper = rec({ name: 'Banana' });
    expect(compareRecords(lower, upper, 'name-asc')).toBeLessThan(0);
    expect(compareRecords(lower, upper, 'name-desc')).toBeGreaterThan(0);
  });

  it('sorts a list deterministically by modified-desc', () => {
    const list = [older, newer];
    const sorted = [...list].sort((x, y) => compareRecords(x, y, 'modified-desc'));
    expect(sorted.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('size-desc / size-asc order by sizeBytes with unsized docs last (JP-444)', () => {
    const big = rec({ id: 'big', sizeBytes: 9000, modifiedAt: 1 });
    const small = rec({ id: 'small', sizeBytes: 100, modifiedAt: 2 });
    const unsized = rec({ id: 'unsized', modifiedAt: 999 });

    const desc = [unsized, small, big].sort((x, y) => compareRecords(x, y, 'size-desc'));
    expect(desc.map((r) => r.id)).toEqual(['big', 'small', 'unsized']);

    const asc = [unsized, small, big].sort((x, y) => compareRecords(x, y, 'size-asc'));
    expect(asc.map((r) => r.id)).toEqual(['small', 'big', 'unsized']);

    // Two unsized docs fall back to recency, keeping the order stable.
    const other = rec({ id: 'other', modifiedAt: 5 });
    expect(compareRecords(unsized, other, 'size-desc')).toBeLessThan(0);
  });
});

// JP-444: the "Shared with me" discriminant. Owner metadata is optional on
// cached records, so absence must mean "not shared", never a crash or a guess.
describe('isSharedWithMe', () => {
  const me = 'u-me';

  it('is true for a relay doc owned by someone else', () => {
    expect(isSharedWithMe(rec({ type: 'remote', ownerId: 'u-other' }), me)).toBe(true);
    expect(isSharedWithMe(rec({ type: 'cached', ownerId: 'u-other' }), me)).toBe(true);
  });

  it('is false for my own docs, local docs, and unknown owners', () => {
    expect(isSharedWithMe(rec({ type: 'remote', ownerId: me }), me)).toBe(false);
    expect(isSharedWithMe(rec({ type: 'local' }), me)).toBe(false);
    expect(isSharedWithMe(rec({ type: 'remote', ownerId: '' }), me)).toBe(false);
    expect(isSharedWithMe(rec({ type: 'cached' }), me)).toBe(false);
  });

  it('is false when signed out (no user id to compare against)', () => {
    expect(isSharedWithMe(rec({ type: 'remote', ownerId: 'u-other' }), undefined)).toBe(false);
  });
});

describe('friendlyTransferError', () => {
  it('maps known status families to actionable copy', () => {
    expect(friendlyTransferError('HTTP 401 unauthorized')).toMatch(/sign in again/i);
    expect(friendlyTransferError('403 forbidden')).toMatch(/owner/i);
    expect(friendlyTransferError('413 payload too large')).toMatch(/too large/i);
    expect(friendlyTransferError('409 version conflict')).toMatch(/changed since/i);
    expect(friendlyTransferError('network fetch failed')).toMatch(/connection/i);
  });

  it('falls back to the raw message and handles undefined', () => {
    expect(friendlyTransferError('weird relay glitch 555')).toBe('weird relay glitch 555');
    expect(friendlyTransferError(undefined)).toBe('Unknown error');
  });
});

describe('permission gates', () => {
  it('canDelete: local + cached always; remote only owner/admin', () => {
    expect(canDelete(rec({ type: 'local' }))).toBe(true);
    expect(canDelete(rec({ type: 'cached' }))).toBe(true);
    expect(canDelete(rec({ type: 'remote', permission: 'owner' }))).toBe(true);
    expect(canDelete(rec({ type: 'remote', permission: 'editor' }))).toBe(false);
    expect(canDelete(rec({ type: 'remote', permission: 'editor' }), 'u', 'admin')).toBe(true);
  });

  it('canEdit: editors can edit remote, viewers cannot', () => {
    expect(canEdit(rec({ type: 'remote', permission: 'editor' }))).toBe(true);
    expect(canEdit(rec({ type: 'remote', permission: 'viewer' }))).toBe(false);
    expect(canEdit(rec({ type: 'remote', permission: 'viewer' }), 'u', 'admin')).toBe(true);
  });

  it('canManagePermissions: only remote owner/admin while in relay mode', () => {
    expect(canManagePermissions(rec({ type: 'remote', permission: 'owner' }), true)).toBe(true);
    expect(canManagePermissions(rec({ type: 'remote', permission: 'owner' }), false)).toBe(false);
    expect(canManagePermissions(rec({ type: 'local' }), true)).toBe(false);
  });

  it('canPublishToRelay: local docs only, and only with a usable relay session', () => {
    expect(canPublishToRelay(rec({ type: 'local' }), true)).toBe(true);
    expect(canPublishToRelay(rec({ type: 'local' }), false)).toBe(false);
    expect(canPublishToRelay(rec({ type: 'remote' }), true)).toBe(false);
  });

  it('canMoveToPersonal: remote owner/admin/self with a usable relay session', () => {
    expect(canMoveToPersonal(rec({ type: 'remote', permission: 'owner' }), true)).toBe(true);
    expect(canMoveToPersonal(rec({ type: 'remote', permission: 'owner' }), false)).toBe(false);
    expect(canMoveToPersonal(rec({ type: 'remote', permission: 'editor', ownerId: 'u' }), true, 'u')).toBe(true);
    expect(canMoveToPersonal(rec({ type: 'remote', permission: 'editor', ownerId: 'x' }), true, 'u')).toBe(false);
    expect(canMoveToPersonal(rec({ type: 'local' }), true)).toBe(false);
  });
});

describe('buildGroupedSections', () => {
  const coll = (id: string, name: string): Collection =>
    ({ id, name, createdAt: 0 }) as Collection;

  const specs = coll('c1', 'Specs');
  const research = coll('c2', 'Research');
  const archive = coll('c3', 'Archive');
  const collections = [specs, research, archive];
  const map = { c1: specs, c2: research, c3: archive };

  const a = rec({ id: 'a', name: 'Alpha' });
  const b = rec({ id: 'b', name: 'Bravo' });
  const loose = rec({ id: 'z', name: 'Zulu' });

  it('emits a section per collection that actually holds documents', () => {
    const sections = buildGroupedSections([a, b], { a: 'c1', b: 'c2' }, map, collections);
    expect(sections.map((s) => s.key)).toEqual(['c1', 'c2']);
  });

  it('omits collections with nothing in the list', () => {
    // The JP-477 defect: filtering the list down to one collection still
    // rendered every other collection as an empty section, contradicting the
    // filter the user had just applied.
    const sections = buildGroupedSections([a], { a: 'c1' }, map, collections);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.collection).toBe(specs);
    expect(sections[0]!.docs).toEqual([a]);
  });

  it('returns no sections at all for an empty list', () => {
    expect(buildGroupedSections([], {}, map, collections)).toEqual([]);
  });

  it('collects unfiled documents into a trailing unassigned section', () => {
    const sections = buildGroupedSections([a, loose], { a: 'c1' }, map, collections);
    expect(sections.map((s) => s.key)).toEqual(['c1', UNASSIGNED_KEY]);
    expect(sections[1]!.collection).toBeNull();
    expect(sections[1]!.docs).toEqual([loose]);
  });

  it('follows the rail order, not the order documents appear in', () => {
    // b is filed under Research (2nd in the rail) but comes first in the list.
    const sections = buildGroupedSections([b, a], { a: 'c1', b: 'c2' }, map, collections);
    expect(sections.map((s) => s.key)).toEqual(['c1', 'c2']);
  });

  it('treats an assignment to a deleted collection as unassigned', () => {
    const sections = buildGroupedSections([a], { a: 'gone' }, map, collections);
    expect(sections.map((s) => s.key)).toEqual([UNASSIGNED_KEY]);
  });

  it('preserves document order within a section', () => {
    const sections = buildGroupedSections([b, a], { a: 'c1', b: 'c1' }, map, collections);
    expect(sections[0]!.docs.map((d) => d.id)).toEqual(['b', 'a']);
  });
});
