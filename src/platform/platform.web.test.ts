/**
 * Web-impl behavior for the platform capabilities. Vitest builds with
 * `__IS_TAURI__ === false` (no `TAURI_ENV_PLATFORM`), so every resolver
 * picks its web implementation — these tests exercise that path under jsdom.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { opener, DOCS_URL } from './opener';
import { windowControls } from './window';
import { fileDrop } from './fileDrop';
import { secureStore } from './secureStore';
import { os } from './os';
import { device } from './device';
import { IS_TAURI } from './runtime';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('runtime', () => {
  it('builds as web (IS_TAURI false) under vitest', () => {
    expect(IS_TAURI).toBe(false);
  });
});

describe('opener (web)', () => {
  it('openExternalUrl opens a new tab', async () => {
    const spy = vi.spyOn(window, 'open').mockReturnValue(null);
    await opener.openExternalUrl('https://example.com/x');
    expect(spy).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer');
  });

  it('openDocs opens the online docs URL', async () => {
    const spy = vi.spyOn(window, 'open').mockReturnValue(null);
    await opener.openDocs();
    expect(spy).toHaveBeenCalledWith(DOCS_URL, '_blank', 'noopener,noreferrer');
  });

  it('chrome commands are no-ops that resolve', async () => {
    await expect(opener.applyCustomChrome(true)).resolves.toBeUndefined();
    await expect(opener.persistCustomChrome(false)).resolves.toBeUndefined();
  });
});

describe('windowControls (web)', () => {
  it('reports unsupported and no-ops', async () => {
    expect(windowControls.isSupported()).toBe(false);
    await expect(windowControls.setDecorations(false)).resolves.toBeUndefined();
    await expect(windowControls.isMaximized()).resolves.toBe(false);
    const unlisten = await windowControls.onResized(() => {});
    expect(typeof unlisten).toBe('function');
    expect(() => unlisten()).not.toThrow();
  });
});

describe('fileDrop (web)', () => {
  it('returns a noop unlisten and never invokes the handler', async () => {
    const handler = vi.fn();
    const unlisten = await fileDrop.onFileDrop(handler);
    expect(typeof unlisten).toBe('function');
    expect(handler).not.toHaveBeenCalled();
    expect(() => unlisten()).not.toThrow();
  });
});

describe('secureStore (localStorage-backed)', () => {
  it('round-trips a value', () => {
    expect(secureStore.getItem('k')).toBeNull();
    secureStore.setItem('k', 'v');
    expect(secureStore.getItem('k')).toBe('v');
    secureStore.removeItem('k');
    expect(secureStore.getItem('k')).toBeNull();
  });
});

describe('os', () => {
  it('is not desktop on web and returns a known OS kind', () => {
    expect(os.isDesktop()).toBe(false);
    expect(['macos', 'windows', 'linux', 'ios', 'android', 'unknown']).toContain(os.kind());
  });
});

describe('device', () => {
  it('reports a viewport band and boolean hints', () => {
    expect(['narrow', 'medium', 'wide']).toContain(device.viewportBand());
    expect(typeof device.isTouch()).toBe('boolean');
    expect(typeof device.prefersReducedMotion()).toBe('boolean');
    expect(typeof device.isLowPower()).toBe('boolean');
  });
});
