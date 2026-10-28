import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the completion + persistence seams so we can assert what the callback
// hands off without starting a real collaboration session.
const completeCloudSignIn = vi.fn(async () => {});
const loadConnection = vi.fn(async () => null as unknown);
vi.mock('./completeCloudSignIn', () => ({
  completeCloudSignIn: (...args: unknown[]) => completeCloudSignIn(...(args as [])),
}));
vi.mock('./relayConnection', () => ({
  loadConnection: () => loadConnection(),
  DEFAULT_CLOUD_BASE_URL: 'https://cloud.test',
}));

import {
  parseAuthCallback,
  parseImportIntent,
  isAuthCallbackRoute,
  handleAuthCallbackIfPresent,
  AUTH_CALLBACK_ENABLED,
  AUTH_CALLBACK_PATH,
} from './authCallback';

describe('authCallback', () => {
  it('is enabled (docushark-web web one-click bridge is live)', () => {
    expect(AUTH_CALLBACK_ENABLED).toBe(true);
  });

  it('recognizes the callback route', () => {
    expect(isAuthCallbackRoute(AUTH_CALLBACK_PATH)).toBe(true);
    expect(isAuthCallbackRoute('/')).toBe(false);
    expect(isAuthCallbackRoute('/settings')).toBe(false);
  });

  it('parses a handoff_code from the query string', () => {
    expect(
      parseAuthCallback('https://app.docushark.app/auth/callback?handoff_code=abc123'),
    ).toEqual({ handoffCode: 'abc123', error: null, importIntent: null });
  });

  it('surfaces an error param with no handoff code', () => {
    expect(
      parseAuthCallback('https://app.docushark.app/auth/callback?error=access_denied'),
    ).toEqual({ handoffCode: null, error: 'access_denied', importIntent: null });
  });

  it('returns no handoff code for a bare callback URL', () => {
    expect(parseAuthCallback('https://app.docushark.app/auth/callback')).toEqual({
      handoffCode: null,
      error: null,
      importIntent: null,
    });
  });

  it('carries an import from the account site with the hand-off (DSK-194)', () => {
    const id = '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';
    expect(
      parseAuthCallback(`https://app.docushark.app/auth/callback?handoff_code=abc123&import=notion:${id}`).importIntent,
    ).toEqual({ provider: 'notion', externalId: id });
    expect(
      parseAuthCallback(`https://app.docushark.app/auth/callback?handoff_code=abc&import=notion:${id}&ws=ws-1`).importIntent,
    ).toEqual({ provider: 'notion', externalId: id, workspaceId: 'ws-1' });
    // A malformed workspace drops the import rather than running it unchecked.
    expect(
      parseAuthCallback(`https://app.docushark.app/auth/callback?handoff_code=abc&import=notion:${id}&ws=a%20b`).importIntent,
    ).toBeNull();
  });

  it('reads an import only in its strict form', () => {
    expect(parseImportIntent('notion:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d')).toEqual({
      provider: 'notion',
      externalId: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
    });
    expect(parseImportIntent(null)).toBeNull();
    expect(parseImportIntent('notion')).toBeNull(); // no id
    expect(parseImportIntent(':abc')).toBeNull(); // no provider
    expect(parseImportIntent('Notion:abc')).toBeNull(); // provider ids are lowercase
    expect(parseImportIntent('notion:abc/../x')).toBeNull();
    expect(parseImportIntent('notion:<script>')).toBeNull();
  });

  it('flags an unparseable URL', () => {
    expect(parseAuthCallback('not a url').error).toBe('invalid_callback_url');
  });

  describe('handleAuthCallbackIfPresent', () => {
    beforeEach(() => {
      completeCloudSignIn.mockClear();
      loadConnection.mockClear();
      loadConnection.mockResolvedValue(null);
      // jsdom: pushState updates window.location.{pathname,href,search}.
      window.history.pushState({}, '', '/');
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      window.history.pushState({}, '', '/');
    });

    it('is a no-op when not on the callback route', async () => {
      window.history.pushState({}, '', '/settings');
      expect(await handleAuthCallbackIfPresent()).toBe(false);
      expect(completeCloudSignIn).not.toHaveBeenCalled();
    });

    it('consumes the code and signs in with the relay URL from the response', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ token: 'tok', expires_at: 1700, relay_url: 'https://relay.test' }),
      }));
      vi.stubGlobal('fetch', fetchMock);
      window.history.pushState({}, '', '/auth/callback?handoff_code=abc123');

      const consumed = await handleAuthCallbackIfPresent();

      expect(consumed).toBe(true);
      // Posts the code to the configured cloud origin's consume route.
      expect(fetchMock).toHaveBeenCalledWith(
        'https://cloud.test/api/v1/auth/web-handoff/consume',
        expect.objectContaining({ method: 'POST' }),
      );
      // Drives the session with the server-resolved relay URL (not a persisted
      // one — there is none for a first-time user) and ms-scaled expiry.
      expect(completeCloudSignIn).toHaveBeenCalledWith({
        relayUrl: 'https://relay.test',
        cloudBaseUrl: 'https://cloud.test',
        token: 'tok',
        expiresAt: 1700 * 1000,
      });
      // Handoff code is scrubbed from the URL.
      expect(window.location.search).toBe('');
    });

    it('bails without signing in when the consume payload is missing relay_url', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, json: async () => ({ token: 'tok', expires_at: 1700 }) })),
      );
      window.history.pushState({}, '', '/auth/callback?handoff_code=abc123');

      expect(await handleAuthCallbackIfPresent()).toBe(true);
      expect(completeCloudSignIn).not.toHaveBeenCalled();
    });

    it('consumes the route but does not sign in when the redirect carried an error', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      window.history.pushState({}, '', '/auth/callback?error=access_denied');

      expect(await handleAuthCallbackIfPresent()).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(completeCloudSignIn).not.toHaveBeenCalled();
    });
  });
});
