import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadConnection,
  saveConnection,
  clearJwt,
  clearConnection,
  __resetMigrationForTests,
} from './relayConnection';
import * as secureKvStore from '../platform/secureKvStore';

const LEGACY_KEY = 'docushark-relay-connection';

describe('relayConnection', () => {
  beforeEach(() => {
    localStorage.clear();
    secureKvStore.__resetForTests();
    __resetMigrationForTests();
  });

  it('returns null when no entry is present', async () => {
    expect(await loadConnection()).toBeNull();
  });

  it('round-trips url + jwt', async () => {
    await saveConnection('http://relay.example:9876', 'JWT-1');
    expect(await loadConnection()).toEqual({
      relayUrl: 'http://relay.example:9876',
      cloudBaseUrl: null,
      jwt: 'JWT-1',
      jwtExpiresAt: null,
      workspaceName: null,
      workspaceSlug: null,
    });
  });

  it('persists URL with a null jwt', async () => {
    await saveConnection('http://relay.example:9876', null);
    expect(await loadConnection()).toEqual({
      relayUrl: 'http://relay.example:9876',
      cloudBaseUrl: null,
      jwt: null,
      jwtExpiresAt: null,
      workspaceName: null,
      workspaceSlug: null,
    });
  });

  it('persists and preserves cloudBaseUrl + jwtExpiresAt', async () => {
    await saveConnection('http://relay.example:9876', 'JWT-1', {
      cloudBaseUrl: 'http://web.example:3000',
      jwtExpiresAt: 1234,
    });
    expect(await loadConnection()).toEqual({
      relayUrl: 'http://relay.example:9876',
      cloudBaseUrl: 'http://web.example:3000',
      jwt: 'JWT-1',
      jwtExpiresAt: 1234,
      workspaceName: null,
      workspaceSlug: null,
    });

    // A later token-only save keeps the previously persisted cloud URL.
    await saveConnection('http://relay.example:9876', 'JWT-2');
    expect((await loadConnection())?.cloudBaseUrl).toBe('http://web.example:3000');
  });

  it('persists and preserves workspace name + slug (JP-343)', async () => {
    await saveConnection('http://relay.example:9876', 'JWT-1', {
      cloudBaseUrl: 'http://web.example:3000',
      jwtExpiresAt: 1234,
      workspaceName: 'JP-Net Research',
      workspaceSlug: 'jp-net-research',
    });
    const saved = await loadConnection();
    expect(saved?.workspaceName).toBe('JP-Net Research');
    expect(saved?.workspaceSlug).toBe('jp-net-research');

    // A later save that omits them (e.g. cached-key reuse) keeps the prior values.
    await saveConnection('http://relay.example:9876', 'JWT-2');
    const after = await loadConnection();
    expect(after?.workspaceName).toBe('JP-Net Research');
    expect(after?.workspaceSlug).toBe('jp-net-research');
  });

  it('clearJwt keeps the URLs but drops the token + expiry + workspace identity', async () => {
    await saveConnection('http://relay.example:9876', 'JWT-1', {
      cloudBaseUrl: 'http://web.example:3000',
      jwtExpiresAt: 1234,
      workspaceName: 'JP-Net Research',
      workspaceSlug: 'jp-net-research',
    });
    await clearJwt();
    expect(await loadConnection()).toEqual({
      relayUrl: 'http://relay.example:9876',
      cloudBaseUrl: 'http://web.example:3000',
      jwt: null,
      jwtExpiresAt: null,
      workspaceName: null,
      workspaceSlug: null,
    });
  });

  it('clearConnection removes the entry entirely', async () => {
    await saveConnection('http://relay.example:9876', 'JWT-1');
    await clearConnection();
    expect(await loadConnection()).toBeNull();
  });

  it('treats malformed JSON as missing', async () => {
    await secureKvStore.setItem(LEGACY_KEY, 'not json');
    expect(await loadConnection()).toBeNull();
  });

  it('rejects entries with a non-string relayUrl', async () => {
    await secureKvStore.setItem(LEGACY_KEY, JSON.stringify({ relayUrl: 42, jwt: 'x' }));
    expect(await loadConnection()).toBeNull();
  });

  describe('legacy localStorage → secureStore migration', () => {
    it('moves a legacy record into the new store and removes the localStorage copy', async () => {
      const record = {
        relayUrl: 'http://relay.example:9876',
        cloudBaseUrl: 'http://web.example:3000',
        jwt: 'LEGACY-JWT',
        jwtExpiresAt: 9999,
      };
      localStorage.setItem(LEGACY_KEY, JSON.stringify(record));

      // First read migrates: returns the record (workspace fields default to null
      // — a pre-JP-343 record simply lacks them) and clears the legacy key.
      const migrated = { ...record, workspaceName: null, workspaceSlug: null };
      expect(await loadConnection()).toEqual(migrated);
      expect(localStorage.getItem(LEGACY_KEY)).toBeNull();

      // The value now lives in the new store (re-arm migration to prove the
      // second read doesn't depend on the legacy copy).
      __resetMigrationForTests();
      expect(await loadConnection()).toEqual(migrated);
    });

    it('does not clobber a value already in the new store', async () => {
      await saveConnection('http://relay.example:9876', 'NEW-JWT');
      localStorage.setItem(LEGACY_KEY, JSON.stringify({ relayUrl: 'http://stale', jwt: 'OLD' }));
      __resetMigrationForTests();
      expect((await loadConnection())?.jwt).toBe('NEW-JWT');
    });
  });
});
