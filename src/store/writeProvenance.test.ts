import { describe, it, expect } from 'vitest';
import {
  getProvenance,
  runWithProvenance,
  mutateDocument,
  type Provenance,
} from './writeProvenance';

describe('writeProvenance (JP-192)', () => {
  it('defaults to user-edit', () => {
    expect(getProvenance()).toBe('user-edit');
  });

  it('sets provenance for the callback duration and restores after', () => {
    const seen: Provenance[] = [];
    const ret = runWithProvenance('load', () => {
      seen.push(getProvenance());
      return 42;
    });
    expect(seen).toEqual(['load']);
    expect(ret).toBe(42);
    expect(getProvenance()).toBe('user-edit');
  });

  it('nests and unwinds to the enclosing provenance', () => {
    // Mirrors the real case: a clear() (load) dispatched inside the bridge's
    // remote-apply adopt block must restore to remote-apply, not user-edit.
    const trail: Provenance[] = [];
    runWithProvenance('remote-apply', () => {
      trail.push(getProvenance());
      runWithProvenance('load', () => {
        trail.push(getProvenance());
      });
      trail.push(getProvenance());
    });
    expect(trail).toEqual(['remote-apply', 'load', 'remote-apply']);
    expect(getProvenance()).toBe('user-edit');
  });

  it('restores provenance even when the callback throws', () => {
    expect(() =>
      runWithProvenance('load', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(getProvenance()).toBe('user-edit');
  });

  it('mutateDocument tags the write provenance', () => {
    const seen: Provenance[] = [];
    mutateDocument('programmatic', () => seen.push(getProvenance()));
    expect(seen).toEqual(['programmatic']);
    expect(getProvenance()).toBe('user-edit');
  });

  it('throws on an async callback (provenance does not survive await) and restores state', () => {
    // The callback's writes would run after provenance was restored → mis-tagged.
    expect(() => runWithProvenance('programmatic', async () => {})).toThrow(/synchronous/);
    // Restored despite the throw — no leaked provenance for the next write.
    expect(getProvenance()).toBe('user-edit');
  });

  it('mutateDocument also rejects an async callback', () => {
    expect(() => mutateDocument('programmatic', async () => {})).toThrow(/synchronous/);
    expect(getProvenance()).toBe('user-edit');
  });
});
