/**
 * commandShortcut (DSK-198): one formatter, platform-aware, for every surface
 * that names a shortcut. The layout tiles showed Mac glyphs on Linux ("⌘⇧2"),
 * the layout chip said "Cmd+Shift+1..4", the Tools palette tile showed the raw
 * token "Mod+K", and tooltips across the app said "Ctrl+…" on a Mac.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  commandShortcut,
  registerCommandSource,
  unregisterCommandSource,
} from './CommandRegistry';

function onPlatform(platform: string): void {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  // The cache is rebuilt when contributed commands change, as in the app.
  unregisterCommandSource('__platform-switch__');
}

afterEach(() => {
  vi.restoreAllMocks();
  unregisterCommandSource('__platform-switch__');
});

describe('commandShortcut (DSK-198)', () => {
  it('spells shortcuts with Ctrl on Linux and Windows', () => {
    onPlatform('Linux x86_64');
    expect(commandShortcut('view.documents')).toBe('Ctrl+Shift+O');
    expect(commandShortcut('view.layout.designer')).toBe('Ctrl+Shift+2');
    expect(commandShortcut('view.commandPalette')).toBe('Ctrl+K');
  });

  it('spells them with glyphs on macOS', () => {
    onPlatform('MacIntel');
    expect(commandShortcut('view.documents')).toBe('⇧⌘O');
    expect(commandShortcut('view.layout.designer')).toBe('⇧⌘2');
    expect(commandShortcut('view.commandPalette')).toBe('⌘K');
  });

  it('names the first of several bindings', () => {
    onPlatform('Linux x86_64');
    // edit.redo is bound to Mod+Shift+Z and Mod+Y.
    expect(commandShortcut('edit.redo')).toBe('Ctrl+Shift+Z');
  });

  it('is undefined for an unknown command', () => {
    expect(commandShortcut('no.such.command')).toBeUndefined();
  });

  it('follows contributed commands as they come and go', () => {
    onPlatform('Linux x86_64');
    registerCommandSource('test-source', () => [
      { id: 'test.contributed', label: 'Contributed', category: 'View', keys: 'Mod+Shift+Y', scope: 'global', execute: () => {} },
    ]);
    expect(commandShortcut('test.contributed')).toBe('Ctrl+Shift+Y');
    unregisterCommandSource('test-source');
    expect(commandShortcut('test.contributed')).toBeUndefined();
  });
});
