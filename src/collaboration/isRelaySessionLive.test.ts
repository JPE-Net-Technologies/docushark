/**
 * JP-199 — `isRelaySessionLive()` distinguishes a token-accepted session from
 * one where the active doc is actually CRDT-synced (the JP-123 gap).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useConnectionStore } from '../store/connectionStore';
import { useCollaborationStore, isRelaySessionLive } from './collaborationStore';

describe('isRelaySessionLive (JP-199)', () => {
  beforeEach(() => {
    useConnectionStore.setState({ status: 'disconnected' });
    useCollaborationStore.setState({ isActive: false, isSynced: false });
  });

  it('is false when not authenticated (no token / WS)', () => {
    useConnectionStore.setState({ status: 'connecting' });
    useCollaborationStore.setState({ isActive: true, isSynced: true });
    expect(isRelaySessionLive()).toBe(false);
  });

  it('is false when authenticated but no active session', () => {
    useConnectionStore.setState({ status: 'authenticated' });
    useCollaborationStore.setState({ isActive: false, isSynced: false });
    expect(isRelaySessionLive()).toBe(false);
  });

  it('is false when authenticated + active but the doc has not synced yet (the JP-123 case)', () => {
    useConnectionStore.setState({ status: 'authenticated' });
    useCollaborationStore.setState({ isActive: true, isSynced: false });
    expect(isRelaySessionLive()).toBe(false);
  });

  it('is true only when authenticated AND the active doc is synced', () => {
    useConnectionStore.setState({ status: 'authenticated' });
    useCollaborationStore.setState({ isActive: true, isSynced: true });
    expect(isRelaySessionLive()).toBe(true);
  });
});
