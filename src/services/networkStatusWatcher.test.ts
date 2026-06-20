/**
 * networkStatusWatcher (JP-237): browser online/offline events drive the relay
 * connection — the fast-path for the common wifi-off case.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const handleNetworkOffline = vi.fn();
const handleNetworkOnline = vi.fn();
vi.mock('../collaboration/collaborationStore', () => ({
  useCollaborationStore: { getState: () => ({ handleNetworkOffline, handleNetworkOnline }) },
}));

import {
  registerNetworkStatusWatcher,
  __resetNetworkStatusWatcherForTests,
} from './networkStatusWatcher';

describe('registerNetworkStatusWatcher', () => {
  beforeEach(() => {
    handleNetworkOffline.mockClear();
    handleNetworkOnline.mockClear();
    __resetNetworkStatusWatcherForTests();
  });

  it('drops the connection on offline', () => {
    const dispose = registerNetworkStatusWatcher();
    window.dispatchEvent(new Event('offline'));
    expect(handleNetworkOffline).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('retries the connection on online', () => {
    const dispose = registerNetworkStatusWatcher();
    window.dispatchEvent(new Event('online'));
    expect(handleNetworkOnline).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('disposer removes the listeners', () => {
    const dispose = registerNetworkStatusWatcher();
    dispose();
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    expect(handleNetworkOffline).not.toHaveBeenCalled();
    expect(handleNetworkOnline).not.toHaveBeenCalled();
  });

  it('is idempotent — a second register while active does not double-bind', () => {
    const dispose1 = registerNetworkStatusWatcher();
    const dispose2 = registerNetworkStatusWatcher();
    window.dispatchEvent(new Event('offline'));
    expect(handleNetworkOffline).toHaveBeenCalledTimes(1);
    dispose2();
    dispose1();
  });
});
