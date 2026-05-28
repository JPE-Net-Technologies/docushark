/**
 * `secureKvStore` async key→string persistence. jsdom provides no IndexedDB,
 * so these exercise the localStorage fallback path (the one that also covers
 * private-mode / storage-disabled graceful degradation).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as secureKvStore from './secureKvStore';

afterEach(() => {
  localStorage.clear();
  secureKvStore.__resetForTests();
});

describe('secureKvStore (localStorage fallback when IndexedDB absent)', () => {
  it('round-trips a value', async () => {
    expect(await secureKvStore.getItem('token')).toBeNull();
    await secureKvStore.setItem('token', 'abc');
    expect(await secureKvStore.getItem('token')).toBe('abc');
    await secureKvStore.removeItem('token');
    expect(await secureKvStore.getItem('token')).toBeNull();
  });

  it('namespaces fallback keys so they do not collide with other state', async () => {
    await secureKvStore.setItem('k', 'v');
    expect(localStorage.getItem('k')).toBeNull();
    expect(localStorage.getItem('docushark-secure:k')).toBe('v');
  });

  it('resolves null for a missing key rather than throwing', async () => {
    expect(await secureKvStore.getItem('nope')).toBeNull();
  });
});
