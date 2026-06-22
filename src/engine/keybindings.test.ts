import { describe, it, expect } from 'vitest';
import { parseCombo, eventMatchesCombo, eventMatchesAny, formatCombo } from './keybindings';
import { getAllCommands, getPaletteCommands, dispatchKey, findShortcutConflicts } from './CommandRegistry';

function key(k: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: k, cancelable: true, ...mods });
}

describe('keybindings — parseCombo', () => {
  it('maps Mod to Ctrl off macOS and Meta on macOS', () => {
    expect(parseCombo('Mod+Z', false)[0]).toMatchObject({ key: 'z', ctrl: true, meta: false });
    expect(parseCombo('Mod+Z', true)[0]).toMatchObject({ key: 'z', ctrl: false, meta: true });
  });

  it('parses modifiers + alternatives', () => {
    const combos = parseCombo('Mod+Shift+Z | Mod+Y', false);
    expect(combos).toHaveLength(2);
    expect(combos[0]).toMatchObject({ key: 'z', ctrl: true, shift: true });
    expect(combos[1]).toMatchObject({ key: 'y', ctrl: true, shift: false });
  });

  it('lowercases named keys (Delete | Backspace, Escape)', () => {
    expect(parseCombo('Delete | Backspace', false).map((c) => c.key)).toEqual(['delete', 'backspace']);
    expect(parseCombo('Escape', false)[0]!.key).toBe('escape');
  });
});

describe('keybindings — matching', () => {
  it('matches exact modifier state only', () => {
    const [combo] = parseCombo('Mod+Z', false);
    expect(eventMatchesCombo(key('z', { ctrlKey: true }), combo!)).toBe(true);
    expect(eventMatchesCombo(key('z'), combo!)).toBe(false); // no ctrl
    expect(eventMatchesCombo(key('z', { ctrlKey: true, shiftKey: true }), combo!)).toBe(false);
  });

  it('eventMatchesAny matches either alternative', () => {
    const combos = parseCombo('Delete | Backspace', false);
    expect(eventMatchesAny(key('Backspace'), combos)).toBe(true);
    expect(eventMatchesAny(key('x'), combos)).toBe(false);
  });
});

describe('keybindings — formatCombo', () => {
  it('formats for Windows/Linux and macOS', () => {
    expect(formatCombo('Mod+Shift+L', false)).toBe('Ctrl+Shift+L');
    expect(formatCombo('Mod+Shift+L', true)).toBe('⇧⌘L'); // Mac order: ⌘ last
    expect(formatCombo('ArrowUp', false)).toBe('↑');
  });
});

describe('CommandRegistry — registry integrity', () => {
  it('has NO shortcut conflicts (same combo + scope)', () => {
    expect(findShortcutConflicts()).toEqual([]);
  });

  it('derives the display hint from keys', () => {
    const undo = getAllCommands().find((c) => c.id === 'edit.undo')!;
    expect(undo.shortcut).toBe(formatCombo('Mod+Z'));
  });

  it('hides reserved bindings from the palette but shows them in the catalogue', () => {
    expect(getAllCommands().some((c) => c.id === 'tool.select')).toBe(true);
    expect(getPaletteCommands().some((c) => c.id === 'tool.select')).toBe(false);
  });
});

describe('CommandRegistry — dispatchKey', () => {
  it('runs a matching canvas command and reports handled', () => {
    const handled = dispatchKey(key('Escape'), 'canvas'); // edit.clearSelection
    expect(handled).toBe(true);
  });

  it('does not dispatch a binding in the wrong scope', () => {
    // edit.clearSelection is canvas-scope; nothing matches Escape in global.
    expect(dispatchKey(key('Escape'), 'global')).toBe(false);
  });

  it('never dispatches reserved bindings (tool keys owned by ToolManager)', () => {
    expect(dispatchKey(key('v'), 'canvas')).toBe(false);
  });
});
