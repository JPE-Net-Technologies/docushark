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
    expect(loadConnection()).toEqual({ relayUrl: 'http://relay.example:9876', jwt: 'JWT-1' });
  });

  it('persists URL with a null jwt', () => {
    saveConnection('http://relay.example:9876', null);
    expect(loadConnection()).toEqual({ relayUrl: 'http://relay.example:9876', jwt: null });
  });

  it('clearJwt keeps the URL but drops the token', () => {
    saveConnection('http://relay.example:9876', 'JWT-1');
    clearJwt();
    expect(loadConnection()).toEqual({ relayUrl: 'http://relay.example:9876', jwt: null });
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
