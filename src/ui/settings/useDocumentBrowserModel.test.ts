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
  canDelete,
  canEdit,
  canManagePermissions,
  canPublishToTeam,
  canMoveToPersonal,
} from './useDocumentBrowserModel';
import type { DocumentRecord } from '../../types/DocumentRegistry';

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

  it('canManagePermissions: only remote owner/admin while in team mode', () => {
    expect(canManagePermissions(rec({ type: 'remote', permission: 'owner' }), true)).toBe(true);
    expect(canManagePermissions(rec({ type: 'remote', permission: 'owner' }), false)).toBe(false);
    expect(canManagePermissions(rec({ type: 'local' }), true)).toBe(false);
  });

  it('canPublishToTeam: local docs only, and only with a usable relay session', () => {
    expect(canPublishToTeam(rec({ type: 'local' }), true)).toBe(true);
    expect(canPublishToTeam(rec({ type: 'local' }), false)).toBe(false);
    expect(canPublishToTeam(rec({ type: 'remote' }), true)).toBe(false);
  });

  it('canMoveToPersonal: remote owner/admin/self with a usable relay session', () => {
    expect(canMoveToPersonal(rec({ type: 'remote', permission: 'owner' }), true)).toBe(true);
    expect(canMoveToPersonal(rec({ type: 'remote', permission: 'owner' }), false)).toBe(false);
    expect(canMoveToPersonal(rec({ type: 'remote', permission: 'editor', ownerId: 'u' }), true, 'u')).toBe(true);
    expect(canMoveToPersonal(rec({ type: 'remote', permission: 'editor', ownerId: 'x' }), true, 'u')).toBe(false);
    expect(canMoveToPersonal(rec({ type: 'local' }), true)).toBe(false);
  });
});
