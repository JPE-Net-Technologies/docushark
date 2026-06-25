import { describe, it, expect } from 'vitest';
import {
  RELAY_LOCATIONS,
  DEFAULT_RELAY_LOCATION,
  DEFAULT_RELAY_BASE_URL,
  locationForUrl,
} from './relayLocations';

describe('relayLocations', () => {
  it('defaults the primary region to Toronto (yyz)', () => {
    expect(DEFAULT_RELAY_LOCATION.id).toBe('yyz');
    expect(RELAY_LOCATIONS).toContain(DEFAULT_RELAY_LOCATION);
  });

  it('falls back to the local dev relay when VITE_RELAY_BASE_URL is unset', () => {
    // No build var is injected in the test env, so the default is the OSS dev relay.
    expect(DEFAULT_RELAY_BASE_URL).toBe('http://localhost:9876');
    expect(DEFAULT_RELAY_LOCATION.relayUrl).toBe('http://localhost:9876');
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
