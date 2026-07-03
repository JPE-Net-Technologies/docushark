/**
 * StatusBar ambient connection chip (JP-237): a persistent Offline/Reconnecting
 * indicator for relay-backed docs that aren't synced — visible even when no
 * provider is attached and no toast can fire.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

let offline = false;
vi.mock('../collaboration/sharedDocOffline', () => ({
  useSharedDocOffline: () => offline,
}));

import { StatusBar } from './StatusBar';
import { useConnectionStore } from '../store/connectionStore';

describe('StatusBar connection chip', () => {
  beforeEach(() => {
    cleanup();
    useConnectionStore.getState().reset();
    offline = false;
  });

  it('hides the chip when not offline (local doc / online)', () => {
    offline = false;
    render(<StatusBar />);
    expect(screen.queryByText('Offline')).toBeNull();
    expect(screen.queryByText('Reconnecting…')).toBeNull();
  });

  it('shows "Offline" when a relay doc is offline and idle', () => {
    offline = true;
    useConnectionStore.getState().setStatus('disconnected');
    render(<StatusBar />);
    expect(screen.getByText('Offline')).toBeTruthy();
  });

  it('shows "Reconnecting…" while connecting', () => {
    offline = true;
    useConnectionStore.getState().setStatus('connecting');
    render(<StatusBar />);
    expect(screen.getByText('Reconnecting…')).toBeTruthy();
  });
});
