import { describe, it, expect } from 'vitest';
import {
  parseAuthCallback,
  isAuthCallbackRoute,
  handleAuthCallbackIfPresent,
  AUTH_CALLBACK_ENABLED,
  AUTH_CALLBACK_PATH,
} from './authCallback';

describe('authCallback', () => {
  it('is disabled until the docushark-web bridge ships', () => {
    expect(AUTH_CALLBACK_ENABLED).toBe(false);
  });

  it('handleAuthCallbackIfPresent is a no-op while disabled', async () => {
    expect(await handleAuthCallbackIfPresent()).toBe(false);
  });

  it('recognizes the callback route', () => {
    expect(isAuthCallbackRoute(AUTH_CALLBACK_PATH)).toBe(true);
    expect(isAuthCallbackRoute('/')).toBe(false);
    expect(isAuthCallbackRoute('/settings')).toBe(false);
  });

  it('parses an access token from the hash fragment', () => {
    expect(
      parseAuthCallback(
        'https://app.docushark.app/auth/callback#access_token=abc123&expires_in=3600',
      ),
    ).toEqual({ accessToken: 'abc123', error: null });
  });

  it('parses an access token from the query string', () => {
    expect(parseAuthCallback('https://app.docushark.app/auth/callback?access_token=q1')).toEqual({
      accessToken: 'q1',
      error: null,
    });
  });

  it('surfaces an error param with no token', () => {
    expect(parseAuthCallback('https://app.docushark.app/auth/callback#error=access_denied')).toEqual(
      { accessToken: null, error: 'access_denied' },
    );
  });

  it('returns no token for a bare callback URL', () => {
    expect(parseAuthCallback('https://app.docushark.app/auth/callback')).toEqual({
      accessToken: null,
      error: null,
    });
  });

  it('flags an unparseable URL', () => {
    expect(parseAuthCallback('not a url').error).toBe('invalid_callback_url');
  });
});
