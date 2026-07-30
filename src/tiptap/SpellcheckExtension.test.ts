/**
 * Spellcheck must be inert on read-only prose (JP-470 S4).
 *
 * A published/guest reader and a viewer-role collab member get a clean page:
 * no squiggles, no dictionary prep, no popover writes, no formatting context
 * menu. Tiptap's `editable: false` blocks TYPING only — every popover/menu
 * action is a programmatic chain it does not block, so each layer carries its
 * own gate. Every read-only assertion here has an editable control asserting
 * the opposite, so deleting any single gate fails a test (mutation-checked).
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { extensions } from '../ui/TiptapEditor';
import {
  rebuildSpellcheck,
  SPELLCHECK_PLUGIN_KEY,
} from './SpellcheckExtension';
import { SpellcheckService } from '../services/SpellcheckService';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';

vi.mock('../services/SpellcheckService', () => ({
  SpellcheckService: {
    prepare: vi.fn(() => Promise.resolve(null)),
    isReady: () => true,
    isMisspelled: (w: string) => w.toLowerCase() === 'mispeled',
    suggest: () => ['misspelled'],
    addToSession: vi.fn(),
    loadCustomWords: vi.fn(),
  },
}));

const CONTENT = '<p>one mispeled word</p>';

let editor: Editor | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  useUIPreferencesStore.setState((s) => ({
    appearancePrefs: { ...s.appearancePrefs, spellcheck: 'custom' as const },
  }));
});

afterEach(() => {
  editor?.destroy();
  editor = null;
  host?.remove();
  host = null;
});

function make(editable: boolean): Editor {
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new Editor({ element: host, extensions, content: CONTENT, editable });
  return editor;
}

function squiggles(): number {
  return host?.querySelectorAll('.spellcheck-error').length ?? 0;
}

describe('SpellcheckExtension on read-only surfaces', () => {
  it('draws no squiggles even when a full decoration set is dispatched', () => {
    const ed = make(false);
    // Adversarial: bypass every scheduling gate and push a complete set
    // through the meta channel — the `decorations` prop gate must still
    // blank the view.
    rebuildSpellcheck(ed.view);
    expect(squiggles()).toBe(0);
  });

  it('draws squiggles on the same content when editable (control)', () => {
    const ed = make(true);
    rebuildSpellcheck(ed.view);
    expect(squiggles()).toBeGreaterThan(0);
  });

  it('skips dictionary prep entirely for a read-only editor', async () => {
    make(false);
    // Tiptap emits `create` on a deferred tick — flush it, or this assertion
    // passes vacuously before `onCreate` ever ran.
    await new Promise((r) => setTimeout(r, 0));
    expect(SpellcheckService.prepare).not.toHaveBeenCalled();
  });

  it('preps the dictionary for an editable editor (control)', async () => {
    make(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(SpellcheckService.prepare).toHaveBeenCalled();
  });

  it('never populates plugin state from the recheck debounce while read-only', () => {
    vi.useFakeTimers();
    try {
      const ed = make(false);
      // Programmatic dispatch reaches a read-only view (remote collab updates
      // do exactly this), which arms the 500ms recheck.
      ed.view.dispatch(ed.state.tr.insertText('mispeled again ', 1, 1));
      vi.advanceTimersByTime(1000);
      const set = SPELLCHECK_PLUGIN_KEY.getState(ed.state);
      expect(set?.find().length ?? 0).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('populates plugin state from the debounce when editable (control)', () => {
    vi.useFakeTimers();
    try {
      const ed = make(true);
      ed.view.dispatch(ed.state.tr.insertText('mispeled again ', 1, 1));
      vi.advanceTimersByTime(1000);
      const set = SPELLCHECK_PLUGIN_KEY.getState(ed.state);
      expect(set?.find().length ?? 0).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-enables decorations when a viewer is promoted mid-session (JP-370)', () => {
    const ed = make(false);
    rebuildSpellcheck(ed.view);
    expect(squiggles()).toBe(0);
    // The collab editor flips editability in place — no remount.
    ed.setEditable(true);
    rebuildSpellcheck(ed.view);
    expect(squiggles()).toBeGreaterThan(0);
    // And demotion blanks them again through the same prop gate.
    ed.setEditable(false);
    rebuildSpellcheck(ed.view);
    expect(squiggles()).toBe(0);
  });
});
