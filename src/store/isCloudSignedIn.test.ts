import { describe, it, expect, beforeEach } from 'vitest';
import { isCloudSignedIn, useRelayDocumentStore } from './relayDocumentStore';
import { useConnectionStore } from './connectionStore';

// The single "signed in to cloud (REST or live)" gate behind transfer / refresh /
// connect-menu. A cached REST-only session (authenticated + valid token, WS
// disconnected) must count as signed in; a stale/absent token must not.
beforeEach(() => {
  useConnectionStore.getState().reset();
  useRelayDocumentStore.getState().setAuthenticated(false);
});

describe('isCloudSignedIn', () => {
  it('false when a valid token exists but the provider is not authenticated', () => {
    useConnectionStore.getState().setToken('jwt', Date.now() + 60_000);
    expect(isCloudSignedIn()).toBe(false);
  });

  it('false when authenticated but there is no token', () => {
    useRelayDocumentStore.getState().setAuthenticated(true);
    expect(isCloudSignedIn()).toBe(false);
  });

  it('false when the token is expired', () => {
    useRelayDocumentStore.getState().setAuthenticated(true);
    useConnectionStore.getState().setToken('jwt', Date.now() - 1);
    expect(isCloudSignedIn()).toBe(false);
  });

  it('true for a REST-only session (authenticated + unexpired token, WS disconnected)', () => {
    useRelayDocumentStore.getState().setAuthenticated(true);
    useConnectionStore.getState().setToken('jwt', Date.now() + 60_000);
    expect(useConnectionStore.getState().status).toBe('disconnected'); // no live WS
    expect(isCloudSignedIn()).toBe(true);
  });

  it('true with a null-expiry token (no known expiry)', () => {
    useRelayDocumentStore.getState().setAuthenticated(true);
    useConnectionStore.getState().setToken('jwt', null);
    expect(isCloudSignedIn()).toBe(true);
  });
});
