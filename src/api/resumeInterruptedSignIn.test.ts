/**
 * Resume service for an interrupted device-code sign-in (JP-455).
 *
 * This module is the single owner of a resumed grant: it polls, redeems the
 * token, and clears the stored grant. Two callers race for it (app boot and the
 * Cloud panel mounting), so the properties that matter are single-flight — a
 * token must never be redeemed twice — and that a terminal outcome always drops
 * the grant so a dead code can't be retried forever.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  loadPendingSignIn: vi.fn(),
  clearPendingSignIn: vi.fn(async () => {}),
  completeCloudSignIn: vi.fn(async () => {}),
  resumeCloudSignIn: vi.fn(),
  authenticated: false,
}));

vi.mock('./pendingSignIn', () => ({
  loadPendingSignIn: h.loadPendingSignIn,
  clearPendingSignIn: h.clearPendingSignIn,
}));
vi.mock('./completeCloudSignIn', () => ({ completeCloudSignIn: h.completeCloudSignIn }));
vi.mock('./cloudAuth', () => ({ resumeCloudSignIn: h.resumeCloudSignIn }));
vi.mock('../store/relayDocumentStore', () => ({
  useRelayDocumentStore: { getState: () => ({ authenticated: h.authenticated }) },
}));
vi.mock('../store/persistenceStore', () => ({
  usePersistenceStore: { getState: () => ({ currentDocumentId: null }) },
}));

import {
  ensureSignInResumed,
  getActiveResume,
  __resetActiveResumeForTests,
} from './resumeInterruptedSignIn';

const GRANT = {
  deviceCode: 'DEV-CODE',
  userCode: 'WXYZ-1234',
  verificationUri: 'http://web/auth/device?user_code=WXYZ-1234',
  intervalMs: 5000,
  expiresAt: Date.now() + 600_000,
  cloudBaseUrl: 'http://web',
  relayUrl: 'http://relay',
};

const TOKEN = { token: 'RELAY.JWT', expiresAt: 123, workspaceName: 'Alpha' };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetActiveResumeForTests();
  h.authenticated = false;
  h.loadPendingSignIn.mockResolvedValue(GRANT);
});

describe('ensureSignInResumed', () => {
  it('returns null when there is no stored grant', async () => {
    h.loadPendingSignIn.mockResolvedValue(null);
    expect(await ensureSignInResumed()).toBeNull();
    expect(h.resumeCloudSignIn).not.toHaveBeenCalled();
  });

  it('drops the grant without polling when already signed in', async () => {
    h.authenticated = true;
    expect(await ensureSignInResumed()).toBeNull();
    expect(h.resumeCloudSignIn).not.toHaveBeenCalled();
    expect(h.clearPendingSignIn).toHaveBeenCalled();
  });

  it('keeps exactly ONE poller when boot and the panel both ask', async () => {
    const d = deferred<typeof TOKEN>();
    h.resumeCloudSignIn.mockReturnValue({ result: d.promise, cancel: vi.fn() });

    const [a, b] = await Promise.all([ensureSignInResumed(), ensureSignInResumed()]);

    // Two callers, one poll loop — otherwise both hammer the same device_code
    // and trip the relay's slow_down backoff.
    expect(h.resumeCloudSignIn).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);

    d.resolve(TOKEN);
    await a!.done;
    // ...and one redemption. Redeeming twice is the bug this guards.
    expect(h.completeCloudSignIn).toHaveBeenCalledTimes(1);
  });

  it('redeems the token, clears the grant, and releases the singleton', async () => {
    const d = deferred<typeof TOKEN>();
    h.resumeCloudSignIn.mockReturnValue({ result: d.promise, cancel: vi.fn() });

    const active = await ensureSignInResumed();
    expect(getActiveResume()).toBe(active);

    d.resolve(TOKEN);
    await expect(active!.done).resolves.toMatchObject({ token: 'RELAY.JWT' });

    expect(h.completeCloudSignIn).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'RELAY.JWT', relayUrl: 'http://relay' }),
    );
    expect(h.clearPendingSignIn).toHaveBeenCalled();
    expect(getActiveResume()).toBeNull();
  });

  it('prefers the region-resolved relay URL from the token response', async () => {
    const d = deferred<typeof TOKEN & { relayUrl: string }>();
    h.resumeCloudSignIn.mockReturnValue({ result: d.promise, cancel: vi.fn() });

    const active = await ensureSignInResumed();
    d.resolve({ ...TOKEN, relayUrl: 'https://yyz.relay.example' });
    await active!.done;

    expect(h.completeCloudSignIn).toHaveBeenCalledWith(
      expect.objectContaining({ relayUrl: 'https://yyz.relay.example' }),
    );
  });

  it('clears the grant on a terminal failure so a dead code is never retried', async () => {
    const d = deferred<never>();
    h.resumeCloudSignIn.mockReturnValue({ result: d.promise, cancel: vi.fn() });

    const active = await ensureSignInResumed();
    d.reject(new Error('access_denied'));

    await expect(active!.done).rejects.toThrow('access_denied');
    expect(h.clearPendingSignIn).toHaveBeenCalled();
    expect(h.completeCloudSignIn).not.toHaveBeenCalled();
    // Released, so a later attempt can start fresh rather than joining a corpse.
    expect(getActiveResume()).toBeNull();
  });
});
