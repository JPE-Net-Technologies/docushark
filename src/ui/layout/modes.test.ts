import { describe, it, expect } from 'vitest';
import { LAYOUT_PRESETS, primaryRegion, propertiesDockedVisible, resolveRegions } from './modes';
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
