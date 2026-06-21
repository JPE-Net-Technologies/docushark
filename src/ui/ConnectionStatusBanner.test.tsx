/**
 * ConnectionStatusBanner (JP-237): renders ONLY in the terminal `offline` phase
 * (never during normal reconnecting), and "Reconnect" retries + opens the relay
 * quick-connect menu.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const reconnectNow = vi.fn();
vi.mock('../collaboration/collaborationStore', () => ({
  useCollaborationStore: { getState: () => ({ reconnectNow }) },
}));

import { ConnectionStatusBanner } from './ConnectionStatusBanner';
import { useConnectionStore } from '../store/connectionStore';

describe('ConnectionStatusBanner', () => {
  beforeEach(() => {
    reconnectNow.mockClear();
    useConnectionStore.getState().reset();
    cleanup();
  });

  it('renders nothing while online', () => {
    useConnectionStore.getState().setReconnectPhase('online');
    const { container } = render(<ConnectionStatusBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing while reconnecting (no flashing during recovery)', () => {
    useConnectionStore.getState().setReconnectPhase('reconnecting');
    const { container } = render(<ConnectionStatusBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the banner only when offline (terminal)', () => {
    useConnectionStore.getState().setReconnectPhase('offline');
    render(<ConnectionStatusBanner />);
    expect(screen.getByText(/connection lost/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
  });

  it('Reconnect retries and opens the relay quick-connect menu', () => {
    useConnectionStore.getState().setReconnectPhase('offline');
    const onEvent = vi.fn();
    window.addEventListener('docushark:open-cloud-connect', onEvent);
    render(<ConnectionStatusBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));

    expect(reconnectNow).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    window.removeEventListener('docushark:open-cloud-connect', onEvent);
  });
});
