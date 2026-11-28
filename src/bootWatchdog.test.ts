/**
 * The boot watchdog in index.html (DSK-78).
 *
 * After a deploy, an old service worker can still serve the old index.html,
 * whose hashed entry files the host no longer has. Their requests come back as
 * the SPA's HTML, the module is refused, and the app never starts, so neither
 * the in-app "Reload" prompt nor the lazy-chunk recovery can run. The watchdog
 * recovers that tab once, and never touches a running one.
 *
 * These run the script itself, with the browser APIs it uses passed in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const script = html.match(/<script id="boot-watchdog">([\s\S]*?)<\/script>/)?.[1] ?? '';


/** Run the script with these browser APIs; `fail` delivers an `error` event as the capture listener sees it. */
function boot(options: { online?: boolean; serviceWorker?: boolean; caches?: boolean; blockedStorage?: boolean } = {}) {
  const { online = true, serviceWorker = true, caches = true, blockedStorage = false } = options;
  let listener: ((event: { target: object }) => void) | null = null;
  const fakeWindow = {
    __dsBooted: undefined as boolean | undefined,
    addEventListener: (type: string, fn: (event: { target: object }) => void, capture: boolean) => {
      if (type === 'error' && capture === true) listener = fn;
    },
  };
  const unregister = vi.fn(async () => true);
  const deleteCache = vi.fn(async () => true);
  const reload = vi.fn();
  const storage = new Map<string, string>();
  const fakeNavigator = {
    onLine: online,
    ...(serviceWorker
      ? { serviceWorker: { getRegistrations: async () => [{ unregister }, { unregister }] } }
      : {}),
  };
  const fakeCaches = caches ? { keys: async () => ['workbox-precache', 'docushark-fonts'], delete: deleteCache } : undefined;
  const fakeSession = blockedStorage
    ? {
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: () => {
          throw new Error('SecurityError');
        },
      }
    : {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
      };
  new Function('window', 'navigator', 'caches', 'sessionStorage', 'location', script)(
    fakeWindow,
    fakeNavigator,
    fakeCaches,
    fakeSession,
    { reload },
  );
  expect(listener).not.toBeNull();
  return { fail: (target: object) => listener!({ target }), window: fakeWindow, reload, unregister, deleteCache, storage };
}

const entryScript = { tagName: 'SCRIPT', src: 'https://app.docushark.app/assets/index-BuSY763e.js' };
const entryStyles = { tagName: 'LINK', rel: 'stylesheet', href: 'https://app.docushark.app/assets/index-DB4mcvvA.css' };
const preload = { tagName: 'LINK', rel: 'modulepreload', href: 'https://app.docushark.app/assets/vendor-1a2b3c4d.js' };

/** Let the unregister and cache promises settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the boot watchdog (DSK-78)', () => {
  beforeEach(() => {
    expect(script.length).toBeGreaterThan(0);
  });

  it('drops the service workers and caches, then reloads once, when the entry script fails', async () => {
    const page = boot();
    page.fail(entryScript);
    await settle();
    expect(page.unregister).toHaveBeenCalledTimes(2);
    expect(page.deleteCache).toHaveBeenCalledWith('workbox-precache');
    expect(page.deleteCache).toHaveBeenCalledWith('docushark-fonts');
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it('recovers from a failed entry stylesheet or module preload the same way', async () => {
    for (const target of [entryStyles, preload]) {
      const page = boot();
      page.fail(target);
      await settle();
      expect(page.reload).toHaveBeenCalledTimes(1);
    }
  });

  it('reloads only once when several entry files fail together', async () => {
    const page = boot();
    page.fail(entryScript);
    page.fail(entryStyles);
    page.fail(preload);
    await settle();
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads a running app: a live session stays put', async () => {
    const page = boot();
    page.window.__dsBooted = true;
    page.fail(entryScript);
    await settle();
    expect(page.reload).not.toHaveBeenCalled();
    expect(page.unregister).not.toHaveBeenCalled();
  });

  it('never loops: a second recovery within 30 seconds does nothing', async () => {
    const page = boot();
    page.storage.set('ds:boot-recovery', String(Date.now() - 5_000));
    page.fail(entryScript);
    await settle();
    expect(page.reload).not.toHaveBeenCalled();
  });

  it('does nothing offline, where dropping the cache would only make it worse', async () => {
    const page = boot({ online: false });
    page.fail(entryScript);
    await settle();
    expect(page.reload).not.toHaveBeenCalled();
    expect(page.unregister).not.toHaveBeenCalled();
  });

  it('ignores files that are not the app’s entry: icons, font preloads, images', async () => {
    const page = boot();
    page.fail({ tagName: 'LINK', rel: 'icon', href: 'https://app.docushark.app/favicon-32x32.png' });
    page.fail({ tagName: 'LINK', rel: 'preload', href: 'https://app.docushark.app/assets/Inter-Regular-abc.woff2' });
    page.fail({ tagName: 'IMG', src: 'https://app.docushark.app/assets/logo-abc.png' });
    page.fail({ tagName: 'SCRIPT', src: 'https://example.com/widget.js' });
    await settle();
    expect(page.reload).not.toHaveBeenCalled();
  });

  it('reloads only once even where session storage is blocked', async () => {
    const page = boot({ blockedStorage: true });
    page.fail(entryScript);
    page.fail(entryStyles);
    await settle();
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads where the browser has no service worker or cache storage', async () => {
    const page = boot({ serviceWorker: false, caches: false });
    page.fail(entryScript);
    await settle();
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it('stands down when the entry module runs, and comes before it in index.html', () => {
    const main = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf8');
    expect(main).toMatch(/__dsBooted = true/);
    expect(html.indexOf('id="boot-watchdog"')).toBeLessThan(html.indexOf('type="module"'));
  });
});
