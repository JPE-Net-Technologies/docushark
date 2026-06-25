import { describe, it, expect, beforeEach } from 'vitest';
import { activeWorkspaceId, DEFAULT_WORKSPACE_ID } from './activeWorkspace';
import { workspaceIdFromRelayToken } from '../api/relayTokenUser';
import { useConnectionStore } from './connectionStore';

/** Build an unsigned JWT (header.payload.sig) — the decoder never verifies. */
function tokenWith(payload: Record<string, unknown>): string {
  const b64url = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url({ alg: 'RS256' })}.${b64url(payload)}.sig`;
}

describe('workspaceIdFromRelayToken', () => {
  it('returns the first workspace claim id', () => {
    expect(workspaceIdFromRelayToken(tokenWith({ wsp: [{ id: 'ws-a', role: 'owner' }] }))).toBe('ws-a');
  });

  it('returns null when there is no usable wsp claim', () => {
    expect(workspaceIdFromRelayToken(tokenWith({ sub: 'u1' }))).toBeNull(); // no wsp
    expect(workspaceIdFromRelayToken(tokenWith({ wsp: [] }))).toBeNull(); // empty
    expect(workspaceIdFromRelayToken(tokenWith({ wsp: [{ role: 'owner' }] }))).toBeNull(); // no id
  });

  it('returns null for a malformed / missing token', () => {
    expect(workspaceIdFromRelayToken('not-a-jwt')).toBeNull();
    expect(workspaceIdFromRelayToken('')).toBeNull();
    expect(workspaceIdFromRelayToken(null)).toBeNull();
    expect(workspaceIdFromRelayToken(undefined)).toBeNull();
  });
});

describe('activeWorkspaceId', () => {
  beforeEach(() => {
    useConnectionStore.getState().reset();
  });

  it('resolves the workspace id from the live token', () => {
    useConnectionStore.getState().setToken(tokenWith({ wsp: [{ id: 'ws-live', role: 'member' }] }));
    expect(activeWorkspaceId()).toBe('ws-live');
  });

  it('falls back to the single-tenant default when there is no token / no claim', () => {
    expect(activeWorkspaceId()).toBe(DEFAULT_WORKSPACE_ID);
    useConnectionStore.getState().setToken(tokenWith({ sub: 'u1' })); // no wsp
    expect(activeWorkspaceId()).toBe(DEFAULT_WORKSPACE_ID);
  });
});
