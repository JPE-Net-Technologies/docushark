import { describe, it, expect, beforeEach, vi } from 'vitest';
import { attemptTokenRefresh, registerTokenRefresher, __resetForTests } from './tokenRefresh';
import { useConnectionStore } from '../store/connectionStore';

beforeEach(() => {
  __resetForTests();
  useConnectionStore.getState().setToken(null, null);
});

describe('attemptTokenRefresh', () => {
  it('resolves false with no refresher registered, leaving the token untouched', async () => {
    expect(await attemptTokenRefresh()).toBe(false);
    expect(useConnectionStore.getState().token).toBeNull();
  });

  it('commits the refreshed token and resolves true', async () => {
    registerTokenRefresher(async () => ({ token: 'FRESH', expiresAt: 12345 }));
    expect(await attemptTokenRefresh()).toBe(true);
    expect(useConnectionStore.getState().token).toBe('FRESH');
    expect(useConnectionStore.getState().tokenExpiresAt).toBe(12345);
  });

  it('coalesces concurrent callers into a single refresher invocation', async () => {
    const refresher = vi.fn(async () => ({ token: 'X', expiresAt: null }));
    registerTokenRefresher(refresher);
    const results = await Promise.all([attemptTokenRefresh(), attemptTokenRefresh()]);
    expect(results).toEqual([true, true]);
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it('resolves false when the refresher throws, leaving the token untouched', async () => {
    registerTokenRefresher(async () => {
      throw new Error('network down');
    });
    expect(await attemptTokenRefresh()).toBe(false);
    expect(useConnectionStore.getState().token).toBeNull();
  });

  it('runs a fresh attempt after the previous one settles', async () => {
    const refresher = vi.fn(async () => ({ token: 'Y', expiresAt: null }));
    registerTokenRefresher(refresher);
    await attemptTokenRefresh();
    await attemptTokenRefresh();
    expect(refresher).toHaveBeenCalledTimes(2);
  });
});
