import { describe, it, expect } from 'vitest';
import {
  parseAuthCallback,
  isAuthCallbackRoute,
  handleAuthCallbackIfPresent,
  AUTH_CALLBACK_ENABLED,
  AUTH_CALLBACK_PATH,
} from './authCallback';

describe('authCallback', () => {
  it('is disabled until the docushark-web bridge (JP-103) ships', () => {
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

  it('parses a handoff_code from the query string', () => {
    expect(
      parseAuthCallback('https://app.docushark.app/auth/callback?handoff_code=abc123'),
    ).toEqual({ handoffCode: 'abc123', error: null });
  });

  it('surfaces an error param with no handoff code', () => {
    expect(
      parseAuthCallback('https://app.docushark.app/auth/callback?error=access_denied'),
    ).toEqual({ handoffCode: null, error: 'access_denied' });
  });

  it('returns no handoff code for a bare callback URL', () => {
    expect(parseAuthCallback('https://app.docushark.app/auth/callback')).toEqual({
      handoffCode: null,
      error: null,
    });
  });

  it('flags an unparseable URL', () => {
    expect(parseAuthCallback('not a url').error).toBe('invalid_callback_url');
  });
});
