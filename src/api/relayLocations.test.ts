import { describe, it, expect } from 'vitest';
import {
  RELAY_LOCATIONS,
  DEFAULT_RELAY_LOCATION,
  DEFAULT_RELAY_BASE_URL,
  locationForUrl,
  isLocalRelayUrl,
} from './relayLocations';

describe('relayLocations', () => {
  it('a localhost relay presents as Development, never as a Cloud region', () => {
    // No build var is injected in the test env, so the default is the OSS dev
    // relay — and the location label must be keyed on that URL, not on the
    // primary region's name ("Toronto, Canada" for :9876 was a lie).
    expect(DEFAULT_RELAY_BASE_URL).toBe('http://localhost:9876');
    expect(DEFAULT_RELAY_LOCATION.id).toBe('dev');
    expect(DEFAULT_RELAY_LOCATION.label).toContain('Development');
    expect(DEFAULT_RELAY_LOCATION.relayUrl).toBe('http://localhost:9876');
    expect(RELAY_LOCATIONS).toContain(DEFAULT_RELAY_LOCATION);
  });

  it('classifies loopback origins as local; hosted origins as regional', () => {
    for (const local of [
      'http://localhost:9876',
      'http://127.0.0.1:9876',
      'http://[::1]:9876',
      'http://localhost:9876/',
    ]) {
      expect(isLocalRelayUrl(local)).toBe(true);
    }
    for (const hosted of [
      'https://relay-yyz.docushark.app',
      'https://docushark-relay-staging.fly.dev',
      'not a url',
      '',
    ]) {
      expect(isLocalRelayUrl(hosted)).toBe(false);
    }
  });

  describe('locationForUrl', () => {
    it('matches a known origin exactly', () => {
      expect(locationForUrl(DEFAULT_RELAY_LOCATION.relayUrl)).toBe(DEFAULT_RELAY_LOCATION);
    });

    it('normalizes trailing slashes and surrounding whitespace', () => {
      expect(locationForUrl(`  ${DEFAULT_RELAY_LOCATION.relayUrl}/  `)).toBe(DEFAULT_RELAY_LOCATION);
    });

    it('returns undefined for a custom/self-host origin', () => {
      expect(locationForUrl('https://relay.example.com')).toBeUndefined();
    });

    it('returns undefined for an empty string', () => {
      expect(locationForUrl('')).toBeUndefined();
    });
  });
});
