/**
 * Key-combo primitives for the central keyboard registry.
 *
 * A binding is declared as a string spec (e.g. `"Mod+Shift+L"`, `"Delete | Backspace"`)
 * and parsed into one or more {@link KeyCombo}s. `Mod` resolves to ⌘ on macOS and
 * Ctrl elsewhere, so a single declaration is correct cross-platform. These are
 * pure functions (no DOM/global state) — unit-tested in isolation.
 */

/** A single parsed key combination. */
export interface KeyCombo {
  /** The non-modifier key, lowercased for letters (e.g. `'z'`, `'arrowup'`, `'escape'`, `'/'`). */
  key: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

/** Where a binding is active / dispatched. */
export type KeyScope =
  /** Window-level, app-wide (palette, layout, undo when nothing focused). */
  | 'global'
  /** Only when the canvas owns focus (tools, delete, copy/paste shapes). */
  | 'canvas'
  /** Owned by the prose editor (Tiptap); reference-only — we never dispatch. */
  | 'prose';

const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');

/** Normalize an `event.key` to the canonical form used by {@link KeyCombo}. */
function normalizeKey(key: string): string {
  if (key.length === 1) return key.toLowerCase();
  return key.toLowerCase();
}

/**
 * Parse a binding spec into combos. Multiple alternatives are separated by `|`
 * (e.g. `"Mod+Shift+Z | Mod+Y"`); modifiers within a combo by `+`. Recognized
 * modifier tokens: `Mod` (Ctrl/⌘), `Ctrl`, `Meta`/`Cmd`, `Shift`, `Alt`/`Option`.
 */
export function parseCombo(spec: string, mac: boolean = isMacPlatform()): KeyCombo[] {
  return spec.split('|').map((part) => {
    const tokens = part.trim().split('+').map((t) => t.trim()).filter(Boolean);
    const combo: KeyCombo = { key: '', ctrl: false, meta: false, shift: false, alt: false };
    for (const token of tokens) {
      const t = token.toLowerCase();
      if (t === 'mod') {
        if (mac) combo.meta = true;
        else combo.ctrl = true;
      } else if (t === 'ctrl' || t === 'control') {
        combo.ctrl = true;
      } else if (t === 'meta' || t === 'cmd' || t === 'command') {
        combo.meta = true;
      } else if (t === 'shift') {
        combo.shift = true;
      } else if (t === 'alt' || t === 'option' || t === 'opt') {
        combo.alt = true;
      } else {
        combo.key = normalizeKey(token);
      }
    }
    return combo;
  });
}

/**
 * Physical `event.code` for a layout-sensitive `combo.key`. Shifted digits and
 * punctuation report a different `event.key` per layout (Shift+1 → "!", Shift+\
 * → "|"), so for those we match the physical code instead. Letters stay
 * key-based so they remain layout-aware (AZERTY etc.). Null = match by key only.
 */
function expectedCode(key: string): string | null {
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  const punct: Record<string, string> = {
    '\\': 'Backslash', '/': 'Slash', '.': 'Period', ',': 'Comma',
    ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight',
    '-': 'Minus', '=': 'Equal', '`': 'Backquote',
  };
  return punct[key] ?? null;
}

/** Does a keyboard event match this combo? `Mod` matched ctrl OR meta per platform. */
export function eventMatchesCombo(e: KeyboardEvent, combo: KeyCombo): boolean {
  if (e.ctrlKey !== combo.ctrl) return false;
  if (e.metaKey !== combo.meta) return false;
  if (e.shiftKey !== combo.shift) return false;
  if (e.altKey !== combo.alt) return false;
  if (normalizeKey(e.key) === combo.key) return true;
  // Fall back to the physical code for shifted digits/punctuation.
  const code = expectedCode(combo.key);
  return code !== null && e.code === code;
}

export function eventMatchesAny(e: KeyboardEvent, combos: KeyCombo[]): boolean {
  return combos.some((c) => eventMatchesCombo(e, c));
}

const KEY_DISPLAY: Record<string, string> = {
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
  escape: 'Esc', delete: 'Del', backspace: 'Backspace', enter: 'Enter', ' ': 'Space',
};

/** Human-readable label for the first combo of a spec (for the help panel + palette). */
export function formatCombo(spec: string, mac: boolean = isMacPlatform()): string {
  const [first] = parseCombo(spec, mac);
  if (!first) return '';
  const parts: string[] = [];
  if (first.ctrl) parts.push(mac ? '⌃' : 'Ctrl');
  if (first.alt) parts.push(mac ? '⌥' : 'Alt');
  if (first.shift) parts.push(mac ? '⇧' : 'Shift');
  if (first.meta) parts.push(mac ? '⌘' : 'Win');
  const k = first.key;
  parts.push(KEY_DISPLAY[k] ?? (k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1)));
  return parts.join(mac ? '' : '+');
}
