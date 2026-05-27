import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadConnection,
  saveConnection,
  clearJwt,
  clearConnection,
} from './relayConnection';

describe('relayConnection', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns null when no entry is present', () => {
    expect(loadConnection()).toBeNull();
  });

  it('round-trips url + jwt', () => {
    saveConnection('http://relay.example:9876', 'JWT-1');
    expect(loadConnection()).toEqual({
      relayUrl: 'http://relay.example:9876',
      cloudBaseUrl: null,
      jwt: 'JWT-1',
      jwtExpiresAt: null,
    });
  });

  it('persists URL with a null jwt', () => {
    saveConnection('http://relay.example:9876', null);
    expect(loadConnection()).toEqual({
      relayUrl: 'http://relay.example:9876',
      cloudBaseUrl: null,
      jwt: null,
      jwtExpiresAt: null,
    });
  });

  it('persists and preserves cloudBaseUrl + jwtExpiresAt', () => {
    saveConnection('http://relay.example:9876', 'JWT-1', {
      cloudBaseUrl: 'http://web.example:3000',
      jwtExpiresAt: 1234,
    });
    expect(loadConnection()).toEqual({
      relayUrl: 'http://relay.example:9876',
      cloudBaseUrl: 'http://web.example:3000',
      jwt: 'JWT-1',
      jwtExpiresAt: 1234,
    });

    // A later token-only save keeps the previously persisted cloud URL.
    saveConnection('http://relay.example:9876', 'JWT-2');
    expect(loadConnection()?.cloudBaseUrl).toBe('http://web.example:3000');
  });

  it('clearJwt keeps the URLs but drops the token + expiry', () => {
    saveConnection('http://relay.example:9876', 'JWT-1', {
      cloudBaseUrl: 'http://web.example:3000',
      jwtExpiresAt: 1234,
    });
    clearJwt();
    expect(loadConnection()).toEqual({
      relayUrl: 'http://relay.example:9876',
      cloudBaseUrl: 'http://web.example:3000',
      jwt: null,
      jwtExpiresAt: null,
    });
  });

  it('clearConnection removes the entry entirely', () => {
    saveConnection('http://relay.example:9876', 'JWT-1');
    clearConnection();
    expect(loadConnection()).toBeNull();
  });

  it('treats malformed JSON as missing', () => {
    localStorage.setItem('docushark-relay-connection', 'not json');
    expect(loadConnection()).toBeNull();
  });

  it('rejects entries with a non-string relayUrl', () => {
    localStorage.setItem(
      'docushark-relay-connection',
      JSON.stringify({ relayUrl: 42, jwt: 'x' }),
    );
    expect(loadConnection()).toBeNull();
  });
});
