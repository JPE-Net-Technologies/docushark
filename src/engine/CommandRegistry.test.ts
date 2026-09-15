import { describe, it, expect, afterEach } from 'vitest';
import {
  getPaletteCommands,
  findShortcutConflicts,
  getAllCommands,
  getToolsActions,
  isOnSurface,
  registerCommandSource,
  unregisterCommandSource,
  type Command,
} from './CommandRegistry';

describe('CommandRegistry palette', () => {
  it('exposes the PDF export and import commands (reachable from the mobile palette)', () => {
    const ids = getPaletteCommands().map((c) => c.id);
    expect(ids).toContain('file.exportPdf');
    expect(ids).toContain('import.diagram');
    expect(ids).toContain('view.toggleWhiteboard');
    expect(ids).toContain('view.docs');
  });

  it('import.diagram carries a read-only guard (mirrors the toolbar button)', () => {
    const importCmd = getPaletteCommands().find((c) => c.id === 'import.diagram');
    expect(importCmd?.canExecute).toBeTypeOf('function');
  });

  it('has no conflicting keyboard bindings', () => {
    expect(findShortcutConflicts()).toEqual([]);
  });
});

// --- Action surfaces + the contribution seam (JP-506) ---------------------
//
// This is the interface the Tools grid renders and the integration action
// catalogue will contribute to, so the defaults matter more than usual: a
// mistake here silently changes what every existing command does.

describe('action surfaces', () => {
  it('a command with no `surfaces` is palette-only — the pre-existing behaviour', () => {
    // Every command predates surfaces, so the default has to leave them exactly
    // where they were. Getting this backwards would dump the whole registry
    // into the Tools grid.
    const cmd: Command = { id: 't.x', label: 'x', category: 'View', execute: () => {} };
    expect(isOnSurface(cmd, 'palette')).toBe(true);
    expect(isOnSurface(cmd, 'tools')).toBe(false);
  });

  it('an explicit surface list is honoured in both directions', () => {
    const toolsOnly: Command = {
      id: 't.y', label: 'y', category: 'View', execute: () => {}, surfaces: ['tools'],
    };
    expect(isOnSurface(toolsOnly, 'tools')).toBe(true);
    expect(isOnSurface(toolsOnly, 'palette')).toBe(false);
  });

  it('the four Tools actions are on BOTH surfaces, and carry icons', () => {
    // The tile anatomy opens with an icon chip, so a tools action without one
    // cannot render — getToolsActions drops it rather than leaving a hole.
    const tools = getToolsActions();
    const ids = tools.map((c) => c.id);
    for (const id of ['import.diagram', 'file.exportPdf', 'view.toggleWhiteboard']) {
      expect(ids).toContain(id);
    }
    expect(tools.every((c) => c.icon)).toBe(true);
  });

  it('version history is now reachable from the palette, not just the toolbar', () => {
    // It used to be built inline in UnifiedToolbar and existed nowhere else.
    expect(getAllCommands().map((c) => c.id)).toContain('file.versionHistory');
  });
});

describe('command sources', () => {
  afterEach(() => unregisterCommandSource('test-src'));

  it('contributes commands into the palette', () => {
    registerCommandSource('test-src', () => [
      { id: 'src.a', label: 'From a source', category: 'File', execute: () => {} },
    ]);
    expect(getPaletteCommands().map((c) => c.id)).toContain('src.a');
  });

  it('re-registering the same id replaces rather than duplicates', () => {
    // A dev-server module reload re-runs registration; appending would grow the
    // palette a copy at a time.
    const src = () => [{ id: 'src.b', label: 'b', category: 'File', execute: () => {} } as Command];
    registerCommandSource('test-src', src);
    registerCommandSource('test-src', src);
    expect(getPaletteCommands().filter((c) => c.id === 'src.b')).toHaveLength(1);
  });

  it('unregistering removes the contributed commands', () => {
    registerCommandSource('test-src', () => [
      { id: 'src.c', label: 'c', category: 'File', execute: () => {} },
    ]);
    unregisterCommandSource('test-src');
    expect(getPaletteCommands().map((c) => c.id)).not.toContain('src.c');
  });

  it('a source that throws cannot take out the palette', () => {
    // Integrations contribute at runtime off live store state. A contributor
    // blowing up must cost its own actions, never the ones the user cannot
    // work without.
    registerCommandSource('test-src', () => {
      throw new Error('contributor exploded');
    });
    expect(() => getPaletteCommands()).not.toThrow();
    expect(getPaletteCommands().map((c) => c.id)).toContain('file.exportPdf');
  });

  it('a contributed tools action WITHOUT an icon is dropped, not rendered as a hole', () => {
    // The realistic case: a provider contributes an action and forgets the
    // glyph. The tile anatomy opens with an icon chip, so rendering it anyway
    // would leave a visibly broken tile in the grid.
    registerCommandSource('test-src', () => [
      { id: 'src.noicon', label: 'no icon', category: 'File', execute: () => {}, surfaces: ['tools'] },
    ]);
    expect(getToolsActions().map((c) => c.id)).not.toContain('src.noicon');
  });

  it('a contributed command is re-evaluated on every read, so it can come and go', () => {
    // This is what makes an integration action appear when a provider connects
    // without anything having to invalidate a cache.
    let available = true;
    registerCommandSource('test-src', () =>
      available ? [{ id: 'src.d', label: 'd', category: 'File', execute: () => {} } as Command] : [],
    );
    expect(getPaletteCommands().map((c) => c.id)).toContain('src.d');
    available = false;
    expect(getPaletteCommands().map((c) => c.id)).not.toContain('src.d');
  });
});
