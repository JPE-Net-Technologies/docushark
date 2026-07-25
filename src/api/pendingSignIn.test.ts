/**
 * Durable in-flight sign-in grant (JP-455).
 *
 * Pins the two properties the resume path depends on: a grant survives a
 * round-trip, and a grant that can no longer succeed (expired, malformed,
 * written by an older build) is rejected AND cleared rather than handed back to
 * drive a doomed poll.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  savePendingSignIn,
  loadPendingSignIn,
  clearPendingSignIn,
  type PendingSignIn,
} from './pendingSignIn';

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock('../platform/secureStore', () => ({
  secureStore: {
    getItem: (k: string) => Promise.resolve(store.get(k) ?? null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve();
    },
    removeItem: (k: string) => {
      store.delete(k);
      return Promise.resolve();
    },
  },
}));

const KEY = 'docushark-pending-signin';

const grant: PendingSignIn = {
  deviceCode: 'dev-code-abc',
  userCode: 'WXYZ-1234',
  verificationUri: 'http://web/auth/device?user_code=WXYZ-1234',
  intervalMs: 5000,
  expiresAt: 10_000,
  cloudBaseUrl: 'http://web',
  relayUrl: 'http://relay',
};

describe('pendingSignIn', () => {
  beforeEach(() => {
    store.clear();
  });

  it('round-trips a live grant', async () => {
    await savePendingSignIn(grant);
    expect(await loadPendingSignIn(() => 5_000)).toEqual(grant);
  });

  it('returns null when nothing is stored', async () => {
    expect(await loadPendingSignIn(() => 0)).toBeNull();
  });

  it('rejects AND clears an expired grant so it can never be re-polled', async () => {
    await savePendingSignIn(grant);

    // Exactly at expiry counts as expired — the relay would reject it anyway.
    expect(await loadPendingSignIn(() => grant.expiresAt)).toBeNull();
    expect(store.has(KEY)).toBe(false);
  });

  it('rejects AND clears a malformed record', async () => {
    store.set(KEY, '{not json');
    expect(await loadPendingSignIn(() => 0)).toBeNull();
    expect(store.has(KEY)).toBe(false);
  });

  it('rejects AND clears a record missing required fields', async () => {
    // Shape an older build might have written: no deviceCode, so a poll built
    // from it could never succeed.
    store.set(KEY, JSON.stringify({ userCode: 'AAAA-1111', expiresAt: 9_999 }));
    expect(await loadPendingSignIn(() => 0)).toBeNull();
    expect(store.has(KEY)).toBe(false);
  });

  it('clearPendingSignIn removes the record', async () => {
    await savePendingSignIn(grant);
    await clearPendingSignIn();
    expect(await loadPendingSignIn(() => 0)).toBeNull();
  });
});
