import { describe, it, expect, beforeEach, vi } from 'vitest';

const refreshDocumentList = vi.fn();
vi.mock('../store/relayDocumentStore', () => ({
  useRelayDocumentStore: { getState: () => ({ refreshDocumentList }) },
}));

import {
  registerRelayListAutoRefresh,
  __resetRelayListAutoRefreshForTests,
} from './relayListAutoRefresh';

describe('registerRelayListAutoRefresh', () => {
  beforeEach(() => {
    refreshDocumentList.mockReset();
    __resetRelayListAutoRefreshForTests();
  });

  it('refreshes on window focus', () => {
    const dispose = registerRelayListAutoRefresh(() => 0);
    window.dispatchEvent(new Event('focus'));
    expect(refreshDocumentList).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('refreshes on coming back online', () => {
    const dispose = registerRelayListAutoRefresh(() => 0);
    window.dispatchEvent(new Event('online'));
    expect(refreshDocumentList).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('refreshes on visibilitychange only when visible', () => {
    const dispose = registerRelayListAutoRefresh(() => 0);

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(refreshDocumentList).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(refreshDocumentList).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('throttles the focus + visibility double-fire on a single tab return', () => {
    let clock = 1000;
    const dispose = registerRelayListAutoRefresh(() => clock);

    // visibility → visible, then focus, within the same instant: one refresh.
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    expect(refreshDocumentList).toHaveBeenCalledTimes(1);

    // After the throttle window, another return refreshes again.
    clock += 2_500;
    window.dispatchEvent(new Event('focus'));
    expect(refreshDocumentList).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('disposer removes the listeners (no refresh after dispose)', () => {
    const dispose = registerRelayListAutoRefresh(() => 0);
    dispose();
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    expect(refreshDocumentList).not.toHaveBeenCalled();
  });

  it('is idempotent — a second register while active does not double-bind', () => {
    const dispose1 = registerRelayListAutoRefresh(() => 0);
    const dispose2 = registerRelayListAutoRefresh(() => 0); // no-op, returns a noop disposer
    window.dispatchEvent(new Event('focus'));
    expect(refreshDocumentList).toHaveBeenCalledTimes(1);
    dispose2();
    dispose1();
  });
});
