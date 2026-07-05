/**
 * connectionWakeWatcher (JP-420): tab-visible / window-focus hands off to
 * collaborationStore.handleAppWake so a backgrounded PWA recovers its
 * connection (and token) on return without user intervention.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const handleAppWake = vi.fn();
vi.mock('../collaboration/collaborationStore', () => ({
  useCollaborationStore: { getState: () => ({ handleAppWake }) },
}));

import {
  registerConnectionWakeWatcher,
  __resetConnectionWakeWatcherForTests,
} from './connectionWakeWatcher';

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

describe('registerConnectionWakeWatcher', () => {
  beforeEach(() => {
    handleAppWake.mockClear();
    __resetConnectionWakeWatcherForTests();
    setVisibility('visible');
  });

  it('wakes on window focus', () => {
    const dispose = registerConnectionWakeWatcher();
    window.dispatchEvent(new Event('focus'));
    expect(handleAppWake).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('wakes on visibilitychange → visible', () => {
    const dispose = registerConnectionWakeWatcher();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(handleAppWake).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('ignores visibilitychange while hidden', () => {
    const dispose = registerConnectionWakeWatcher();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(handleAppWake).not.toHaveBeenCalled();
    dispose();
  });

  it('throttle collapses the focus + visibilitychange double-fire', () => {
    let t = 0;
    const dispose = registerConnectionWakeWatcher(() => t);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(handleAppWake).toHaveBeenCalledTimes(1);

    // Past the throttle window a new wake fires again.
    t = 5_000;
    window.dispatchEvent(new Event('focus'));
    expect(handleAppWake).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('disposer removes the listeners', () => {
    const dispose = registerConnectionWakeWatcher();
    dispose();
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(handleAppWake).not.toHaveBeenCalled();
  });

  it('is idempotent — a second register while active does not double-bind', () => {
    const dispose1 = registerConnectionWakeWatcher();
    const dispose2 = registerConnectionWakeWatcher();
    window.dispatchEvent(new Event('focus'));
    expect(handleAppWake).toHaveBeenCalledTimes(1);
    dispose2();
    dispose1();
  });
});
