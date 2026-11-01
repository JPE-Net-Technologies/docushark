import { describe, it, expect } from 'vitest';
import {
  LAYOUT_PRESETS,
  isCanvasHidden,
  primaryRegion,
  propertiesDockedVisible,
  resolveActiveSurface,
  resolveRegions,
  surfacesOnScreen,
} from './modes';
import { LAYOUT_MODES } from './types';
import type { PanelState } from './types';

describe('primaryRegion', () => {
  it('makes Relaxed document-primary (writing-first) and everything else canvas-primary', () => {
    expect(primaryRegion('relaxed')).toBe('document');
    for (const mode of LAYOUT_MODES) {
      if (mode === 'relaxed') continue;
      expect(primaryRegion(mode)).toBe('canvas');
    }
  });
});

describe('resolveRegions', () => {
  it('non-Relaxed layouts are always canvas-primary, no split', () => {
    expect(resolveRegions('designer', 'write', 'wide')).toEqual({ primary: 'canvas', split: false });
    expect(resolveRegions('power', 'split', 'wide')).toEqual({ primary: 'canvas', split: false });
  });

  it('Relaxed write is document-primary with no canvas pane', () => {
    expect(resolveRegions('relaxed', 'write', 'wide')).toEqual({ primary: 'document', split: false });
  });

  it('Relaxed split shows the secondary canvas only when there is room', () => {
    expect(resolveRegions('relaxed', 'split', 'wide')).toEqual({ primary: 'document', split: true });
    expect(resolveRegions('relaxed', 'split', 'medium')).toEqual({ primary: 'document', split: true });
    // Narrow viewport collapses to single-pane prose (the mobile-shaped fallback).
    expect(resolveRegions('relaxed', 'split', 'narrow')).toEqual({ primary: 'document', split: false });
  });

  it('Relaxed diagram promotes the canvas to primary', () => {
    expect(resolveRegions('relaxed', 'diagram', 'wide')).toEqual({ primary: 'canvas', split: false });
    expect(resolveRegions('relaxed', 'diagram', 'narrow')).toEqual({ primary: 'canvas', split: false });
  });
});

describe('isCanvasHidden (JP-486)', () => {
  it('is false for every non-Relaxed layout — they always render the canvas', () => {
    for (const mode of LAYOUT_MODES) {
      if (mode === 'relaxed') continue;
      // Focus and band are Relaxed-only inputs; no combination may hide it.
      expect(isCanvasHidden(mode, 'write', 'narrow')).toBe(false);
      expect(isCanvasHidden(mode, 'split', 'wide')).toBe(false);
      expect(isCanvasHidden(mode, 'diagram', 'medium')).toBe(false);
    }
  });

  it('is true in Relaxed write focus at every band — prose only, no canvas', () => {
    expect(isCanvasHidden('relaxed', 'write', 'wide')).toBe(true);
    expect(isCanvasHidden('relaxed', 'write', 'medium')).toBe(true);
    expect(isCanvasHidden('relaxed', 'write', 'narrow')).toBe(true);
  });

  it('is false in Relaxed diagram focus — the canvas is the primary region', () => {
    expect(isCanvasHidden('relaxed', 'diagram', 'wide')).toBe(false);
    expect(isCanvasHidden('relaxed', 'diagram', 'narrow')).toBe(false);
  });

  it('tracks split collapsing on narrow: canvas is present only while the split survives', () => {
    expect(isCanvasHidden('relaxed', 'split', 'wide')).toBe(false);
    expect(isCanvasHidden('relaxed', 'split', 'medium')).toBe(false);
    // A narrow viewport forbids the side-by-side split, so the canvas is gone.
    expect(isCanvasHidden('relaxed', 'split', 'narrow')).toBe(true);
  });

  it('agrees with resolveRegions across the whole input space', () => {
    // The helper exists so App and StatusBar cannot drift; pin it to the source
    // of truth rather than to a second hand-written table.
    for (const mode of LAYOUT_MODES) {
      for (const focus of ['write', 'split', 'diagram'] as const) {
        for (const band of ['narrow', 'medium', 'wide'] as const) {
          const regions = resolveRegions(mode, focus, band);
          const expected = regions.primary === 'document' && !regions.split;
          expect(isCanvasHidden(mode, focus, band)).toBe(expected);
        }
      }
    }
  });
});

describe('Relaxed preset (writing-first)', () => {
  it('document fills the primary region (no fixed width) and layers are hidden', () => {
    expect(LAYOUT_PRESETS.relaxed.document.visible).toBe(true);
    expect(LAYOUT_PRESETS.relaxed.document.width).toBeUndefined();
    expect(LAYOUT_PRESETS.relaxed.layers.visible).toBe(false);
    expect(LAYOUT_PRESETS.relaxed.properties.visible).toBe(false);
  });
});

describe('propertiesDockedVisible (JP-410)', () => {
  it('Relaxed never docks Properties — even with a stale pinned+visible override', () => {
    const stalePinned: PanelState = { dock: 'right', visible: true, order: 0, width: 240, pinned: true };
    expect(propertiesDockedVisible('relaxed', stalePinned)).toBe(false);
    expect(propertiesDockedVisible('relaxed', { dock: 'right', visible: false, order: 0 })).toBe(false);
  });

  it('non-Relaxed modes honor state.visible', () => {
    expect(propertiesDockedVisible('designer', { dock: 'right', visible: true, order: 0 })).toBe(true);
    expect(propertiesDockedVisible('technician', { dock: 'right', visible: false, order: 0 })).toBe(false);
    expect(propertiesDockedVisible('power', { dock: 'right', visible: true, order: 0, pinned: true })).toBe(true);
  });
});

describe('surfacesOnScreen (DSK-211)', () => {
  it('shows only prose in Relaxed write focus, at every band', () => {
    for (const band of ['wide', 'medium', 'narrow'] as const) {
      expect(surfacesOnScreen('relaxed', 'write', band, true)).toEqual({ prose: true, canvas: false });
    }
  });

  it('shows only the canvas in Relaxed diagram focus, which collapses the prose panel', () => {
    expect(surfacesOnScreen('relaxed', 'diagram', 'wide', true)).toEqual({ prose: false, canvas: true });
  });

  it('shows both in a Relaxed split, and only prose once a narrow viewport collapses it', () => {
    expect(surfacesOnScreen('relaxed', 'split', 'wide', true)).toEqual({ prose: true, canvas: true });
    expect(surfacesOnScreen('relaxed', 'split', 'narrow', true)).toEqual({ prose: true, canvas: false });
  });

  it('follows the document panel in the other layouts, where the canvas always shows', () => {
    expect(surfacesOnScreen('power', 'write', 'wide', true)).toEqual({ prose: true, canvas: true });
    expect(surfacesOnScreen('designer', 'write', 'wide', false)).toEqual({ prose: false, canvas: true });
  });
});

describe('resolveActiveSurface (DSK-211)', () => {
  it('names the only surface on screen, whatever was worked in last', () => {
    expect(resolveActiveSurface({ prose: true, canvas: false }, 'canvas', 'canvas')).toBe('prose');
    expect(resolveActiveSurface({ prose: false, canvas: true }, 'prose', 'prose')).toBe('canvas');
  });

  it('follows the surface last worked in when both are on screen, else the primary region', () => {
    expect(resolveActiveSurface({ prose: true, canvas: true }, 'canvas', 'prose')).toBe('canvas');
    expect(resolveActiveSurface({ prose: true, canvas: true }, null, 'prose')).toBe('prose');
  });
});
