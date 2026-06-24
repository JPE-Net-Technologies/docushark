/**
 * Tests for the built-in spell-check service. The module keeps a singleton
 * dictionary, so each test re-imports it fresh via `vi.resetModules()`.
 * `nspell` and `fetch` are mocked so the tests don't load the real 550KB
 * dictionary.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Fake nspell — built inside the factory so it survives vi.mock hoisting.
vi.mock('nspell', () => ({
  default: vi.fn(() => {
    const known = new Set(['hello', 'world']);
    return {
      correct: (w: string) => known.has(w.toLowerCase()),
      suggest: (w: string) => (w.toLowerCase().startsWith('wrl') ? ['world'] : []),
      add: (w: string) => known.add(w.toLowerCase()),
      remove: (w: string) => known.delete(w.toLowerCase()),
    };
  }),
}));

function stubFetch(ok: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status: ok ? 200 : 404, text: async () => 'DATA' })),
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SpellcheckService', () => {
  it('prepares, becomes ready, and flags unknown words', async () => {
    stubFetch(true);
    const { SpellcheckService } = await import('./SpellcheckService');

    expect(SpellcheckService.isReady()).toBe(false);
    await SpellcheckService.prepare();
    expect(SpellcheckService.isReady()).toBe(true);

    expect(SpellcheckService.isMisspelled('hello')).toBe(false);
    expect(SpellcheckService.isMisspelled('wrold')).toBe(true);
    expect(SpellcheckService.suggest('wrld')).toContain('world');
  });

  it('prepare() is idempotent — loads the dictionary once', async () => {
    stubFetch(true);
    const { SpellcheckService } = await import('./SpellcheckService');
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    await Promise.all([SpellcheckService.prepare(), SpellcheckService.prepare()]);
    await SpellcheckService.prepare();

    // Exactly two files fetched (en.aff + en.dic), never re-fetched.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null and stays not-ready on load failure, without throwing', async () => {
    stubFetch(false);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { SpellcheckService } = await import('./SpellcheckService');

    const result = await SpellcheckService.prepare();
    expect(result).toBeNull();
    expect(SpellcheckService.isReady()).toBe(false);
    // Safe no-op queries when the dictionary never loaded.
    expect(SpellcheckService.isMisspelled('whatever')).toBe(false);
    expect(SpellcheckService.suggest('whatever')).toEqual([]);
    // The failure is surfaced (not silently swallowed).
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it('addToSession marks a word as known', async () => {
    stubFetch(true);
    const { SpellcheckService } = await import('./SpellcheckService');
    await SpellcheckService.prepare();

    expect(SpellcheckService.isMisspelled('docushark')).toBe(true);
    SpellcheckService.addToSession('Docushark');
    expect(SpellcheckService.isMisspelled('docushark')).toBe(false);
  });
});
