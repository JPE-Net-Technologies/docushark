/**
 * Workspace directory (JP-459).
 *
 * The claims worth pinning are the ones that were wrong before this existed:
 * a user id must never reach a reader as a label, and the fetch that turns ids
 * into people must not stampede or go stale across a workspace switch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkspaceMember } from '../api/webClient';

const h = vi.hoisted(() => ({
  getWorkspaceMembers: vi.fn(),
  workspaceId: 'ws-1',
}));

vi.mock('../api/webClient', () => ({
  webClient: { getWorkspaceMembers: h.getWorkspaceMembers },
}));
vi.mock('./activeWorkspace', () => ({
  activeWorkspaceId: () => h.workspaceId,
}));

import {
  useWorkspaceDirectory,
  resolvePersonName,
  UNKNOWN_PERSON,
} from './workspaceDirectoryStore';

const PRIYA: WorkspaceMember = {
  userId: 'u-priya',
  email: 'priya@example.com',
  displayName: 'Priya Raman',
  role: 'member',
};
const NAMELESS: WorkspaceMember = {
  userId: 'u-nameless',
  email: 'someone@example.com',
  displayName: '',
  role: 'member',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.workspaceId = 'ws-1';
  useWorkspaceDirectory.getState().clear();
  h.getWorkspaceMembers.mockResolvedValue([PRIYA, NAMELESS]);
});

describe('resolvePersonName', () => {
  it('never renders a raw account id', async () => {
    // The bug this whole change exists for: `ownerName` on every pre-JP-459
    // record IS the account id, so the "fall back to the stored name" path
    // rendered a UUID. A UUID tells a reader nothing.
    const id = 'c6df1e26-508b-447e-8fc8-3ac529b58b53';
    expect(resolvePersonName(id, id)).toBe(UNKNOWN_PERSON);
  });

  it('prefers the roster display name over whatever the record stored', async () => {
    await useWorkspaceDirectory.getState().ensureLoaded();
    expect(resolvePersonName('u-priya', 'u-priya')).toBe('Priya Raman');
  });

  it('falls back to the roster email when the display name is blank', async () => {
    await useWorkspaceDirectory.getState().ensureLoaded();
    expect(resolvePersonName('u-nameless', undefined)).toBe('someone@example.com');
  });

  it('accepts a stored name that is genuinely a name', () => {
    // Self-host with no control plane: the record's own string is all we have,
    // and it is usable precisely because it differs from the id.
    expect(resolvePersonName('u-x', 'Sam Okafor')).toBe('Sam Okafor');
  });

  it('is Unknown when there is nothing to go on', () => {
    expect(resolvePersonName('u-x', undefined)).toBe(UNKNOWN_PERSON);
    expect(resolvePersonName('u-x', '   ')).toBe(UNKNOWN_PERSON);
  });
});

describe('ensureLoaded', () => {
  it('is single-flight under concurrent callers', async () => {
    // The document list and the Cloud panel both warm the directory, often on
    // the same tick. Checking a `loaded` flag alone is not enough: it is set
    // after an await, so both callers would see false and both would fetch.
    await Promise.all([
      useWorkspaceDirectory.getState().ensureLoaded(),
      useWorkspaceDirectory.getState().ensureLoaded(),
      useWorkspaceDirectory.getState().ensureLoaded(),
    ]);
    expect(h.getWorkspaceMembers).toHaveBeenCalledTimes(1);
  });

  it('does not refetch once loaded', async () => {
    await useWorkspaceDirectory.getState().ensureLoaded();
    await useWorkspaceDirectory.getState().ensureLoaded();
    expect(h.getWorkspaceMembers).toHaveBeenCalledTimes(1);
  });

  it('invalidates on a workspace switch rather than mixing rosters', async () => {
    await useWorkspaceDirectory.getState().ensureLoaded();
    expect(resolvePersonName('u-priya')).toBe('Priya Raman');

    h.workspaceId = 'ws-2';
    h.getWorkspaceMembers.mockResolvedValue([]);
    await useWorkspaceDirectory.getState().ensureLoaded();

    // Membership and roles are per-workspace; carrying an entry across would
    // report someone as a member of a workspace they aren't in.
    expect(h.getWorkspaceMembers).toHaveBeenCalledTimes(2);
    expect(resolvePersonName('u-priya', 'u-priya')).toBe(UNKNOWN_PERSON);
  });

  it('does not cache a failure — the next caller retries', async () => {
    h.getWorkspaceMembers.mockRejectedValueOnce(new Error('control plane down'));
    await useWorkspaceDirectory.getState().ensureLoaded();
    expect(resolvePersonName('u-priya', 'u-priya')).toBe(UNKNOWN_PERSON);

    // A blip must not leave every name unresolvable for the rest of the session.
    await useWorkspaceDirectory.getState().ensureLoaded();
    expect(resolvePersonName('u-priya')).toBe('Priya Raman');
  });

  it('survives a failure without throwing — names are decoration', async () => {
    h.getWorkspaceMembers.mockRejectedValue(new Error('offline'));
    await expect(useWorkspaceDirectory.getState().ensureLoaded()).resolves.toBeUndefined();
  });
});
