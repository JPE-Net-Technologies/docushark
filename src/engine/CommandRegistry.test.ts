import { describe, it, expect } from 'vitest';
import { getPaletteCommands, findShortcutConflicts } from './CommandRegistry';

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
