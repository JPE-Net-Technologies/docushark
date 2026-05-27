/**
 * Tauri-impl wiring for the platform capabilities. These import the `.tauri`
 * factories directly (bypassing the `__IS_TAURI__` resolver, which is `false`
 * under vitest) with the `@tauri-apps/*` modules mocked, verifying each
 * desktop implementation delegates to the right Tauri API.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createTauriOpener } from './opener.tauri';
import { createTauriWindow } from './window.tauri';
import { createTauriFileSystem } from './fs.tauri';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const win = {
  setDecorations: vi.fn().mockResolvedValue(undefined),
  minimize: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  isMaximized: vi.fn().mockResolvedValue(true),
  onResized: vi.fn().mockResolvedValue(() => {}),
};
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => win),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn().mockResolvedValue(true),
  readTextFile: vi.fn().mockResolvedValue('contents'),
}));
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn().mockResolvedValue('/data/'),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('opener (tauri)', () => {
  it('invokes the right IPC commands', async () => {
    const o = createTauriOpener();
    await o.openExternalUrl('https://x');
    await o.applyCustomChrome(true);
    await o.persistCustomChrome(false);
    expect(invoke).toHaveBeenCalledWith('open_external_url', { url: 'https://x' });
    expect(invoke).toHaveBeenCalledWith('apply_custom_chrome', { enabled: true });
    expect(invoke).toHaveBeenCalledWith('persist_custom_chrome', { enabled: false });
  });

  it('openDocs invokes open_docs', async () => {
    await createTauriOpener().openDocs();
    expect(invoke).toHaveBeenCalledWith('open_docs');
  });

  it('openDocs falls back to a new tab if the command throws', async () => {
    (invoke as Mock).mockRejectedValueOnce(new Error('no command'));
    const spy = vi.spyOn(window, 'open').mockReturnValue(null);
    await createTauriOpener().openDocs();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('windowControls (tauri)', () => {
  it('delegates to the current window', async () => {
    const w = createTauriWindow();
    expect(w.isSupported()).toBe(true);
    await w.setDecorations(false);
    await w.minimize();
    expect(await w.isMaximized()).toBe(true);
    expect(getCurrentWindow).toHaveBeenCalled();
    expect(win.setDecorations).toHaveBeenCalledWith(false);
    expect(win.minimize).toHaveBeenCalled();
  });
});

describe('fileSystem (tauri)', () => {
  it('wraps the fs/path plugins', async () => {
    const fs = createTauriFileSystem();
    expect(await fs.exists('/a')).toBe(true);
    expect(await fs.readTextFile('/a')).toBe('contents');
    expect(await fs.appDataDir()).toBe('/data/');
  });
});
