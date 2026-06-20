/**
 * Connection controller (JP-237): the reconnect-phase + single-toast logic in
 * `initConnectionNotifications`. Verifies an unexpected drop shows ONE updatable
 * toast (no per-status-flip spam), resolves on reconnect, goes terminal on
 * give-up, and stays quiet during an intentional (muted) transition.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the (dynamically-imported) notification store so we can observe toasts.
const notify = vi.fn(() => 'toast-1');
const update = vi.fn();
const dismiss = vi.fn();
const error = vi.fn();
vi.mock('./notificationStore', () => ({
  useNotificationStore: {
    getState: () => ({ notify, update, dismiss, error, success: vi.fn(), warning: vi.fn() }),
  },
}));

import {
  useConnectionStore,
  initConnectionNotifications,
  muteConnectionToasts,
  markReconnectCancelled,
  __resetConnectionControllerForTests,
  type ConnectionStatus,
} from './connectionStore';

let unsub: (() => void) | null = null;

/** Let the controller's dynamic import('./notificationStore').then(...) resolve. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('connection controller (initConnectionNotifications)', () => {
  beforeEach(async () => {
    notify.mockClear();
    update.mockClear();
    dismiss.mockClear();
    error.mockClear();
    useConnectionStore.getState().reset();
    __resetConnectionControllerForTests();
    unsub = initConnectionNotifications();
    await flush();
  });

  afterEach(() => {
    unsub?.();
    unsub = null;
  });

  const set = (status: ConnectionStatus, err?: string) =>
    useConnectionStore.getState().setStatus(status, err);

  it('shows ONE updatable toast across a drop→retry cycle (no spam)', () => {
    set('authenticated'); // establish a prior session
    set('disconnected'); // unexpected drop → create toast
    useConnectionStore.getState().incrementReconnectAttempts();
    set('connecting'); // retry → UPDATE, not a new toast
    set('disconnected'); // bounce → still update

    expect(notify).toHaveBeenCalledTimes(1);
    expect(update.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(useConnectionStore.getState().reconnectPhase).toBe('reconnecting');
  });

  it('resolves to online and dismisses the toast on reconnect', () => {
    vi.useFakeTimers();
    set('authenticated');
    set('disconnected');
    set('connecting');
    set('authenticated'); // reconnected

    // The live toast is updated to a success and then auto-dismissed.
    expect(update).toHaveBeenCalledWith('toast-1', { message: 'Reconnected', severity: 'success' });
    vi.runAllTimers();
    expect(dismiss).toHaveBeenCalledWith('toast-1');
    expect(useConnectionStore.getState().reconnectPhase).toBe('online');
    vi.useRealTimers();
  });

  it('goes terminal (offline) when the provider gives up', () => {
    set('authenticated');
    set('disconnected'); // reconnecting
    set('error', 'Max reconnect attempts reached'); // give up

    expect(dismiss).toHaveBeenCalledWith('toast-1');
    expect(useConnectionStore.getState().reconnectPhase).toBe('offline');
  });

  it('stays quiet during an intentional (muted) transition', () => {
    set('authenticated');
    muteConnectionToasts(8000); // leave/switch/sign-in mutes the churn
    set('disconnected');
    set('connecting');

    expect(notify).not.toHaveBeenCalled();
    expect(useConnectionStore.getState().reconnectPhase).toBe('online');
  });

  it('markReconnectCancelled (user Cancel) dismisses the toast and goes offline', () => {
    set('authenticated');
    set('disconnected'); // reconnecting → toast-1
    markReconnectCancelled(); // user pressed Cancel

    expect(dismiss).toHaveBeenCalledWith('toast-1');
    expect(useConnectionStore.getState().reconnectPhase).toBe('offline');

    // And the latch holds: a further status bounce doesn't re-open the toast.
    notify.mockClear();
    set('connecting');
    expect(notify).not.toHaveBeenCalled();
    expect(useConnectionStore.getState().reconnectPhase).toBe('offline');
  });

  it('does not treat a first-connect failure as an outage', () => {
    // Never authenticated — an error surfaces as a toast, no reconnect phase.
    set('connecting');
    set('error', 'WebSocket error');

    expect(notify).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    expect(useConnectionStore.getState().reconnectPhase).toBe('online');
  });
});
