import { describe, it, expect } from 'vitest';
import { iconOnlyRenderSize, iconOnlyLabelOffsetY, centeredIconRenderSize } from './iconRenderer';

describe('iconOnlyRenderSize', () => {
  it('fills the bounds, aspect-locked to the smaller dimension', () => {
    expect(iconOnlyRenderSize(100, 80)).toBe(80);
    expect(iconOnlyRenderSize(60, 120)).toBe(60);
    expect(iconOnlyRenderSize(64, 64)).toBe(64);
  });
});

describe('iconOnlyLabelOffsetY', () => {
  it('drops the label below the centred icon, sticky to its rendered size', () => {
    // renderSize/2 clears the icon's bottom edge, + one label line for a gap.
    expect(iconOnlyLabelOffsetY(80, 14)).toBe(40 + 14);
    expect(iconOnlyLabelOffsetY(48, 14)).toBe(24 + 14);
  });

  it('is always positive (below centre), never overlapping', () => {
    expect(iconOnlyLabelOffsetY(iconOnlyRenderSize(40, 30), 10)).toBeGreaterThan(0);
  });
});

describe('centeredIconRenderSize', () => {
  it('returns the bound-filling size for icon-only shapes (tracks resize)', () => {
    expect(centeredIconRenderSize({ iconDisplayMode: 'icon-only', iconId: 'x' }, 100, 80)).toBe(80);
    // Larger bounds → larger offset basis: label follows the resize.
    expect(centeredIconRenderSize({ iconDisplayMode: 'icon-only', iconId: 'x' }, 200, 200)).toBe(200);
  });

  it('returns the icon size for a single centred (legacy) icon', () => {
    expect(centeredIconRenderSize({ iconId: 'x', iconPosition: 'center', iconSize: 32 }, 120, 90)).toBe(32);
    expect(centeredIconRenderSize({ iconId: 'x', iconPosition: 'center' }, 120, 90)).toBe(24);
  });

  it('returns null for corner/edge/default icons (no label collision)', () => {
    expect(centeredIconRenderSize({ iconId: 'x' }, 120, 90)).toBeNull(); // default top-left
    expect(centeredIconRenderSize({ iconId: 'x', iconPosition: 'top-right' }, 120, 90)).toBeNull();
    expect(centeredIconRenderSize({ iconId: 'x', iconPosition: 'bottom' }, 120, 90)).toBeNull();
  });

  it('returns null when there is no icon at all', () => {
    expect(centeredIconRenderSize({}, 120, 90)).toBeNull();
  });

  it('handles a single centred icon in the icons[] array', () => {
    expect(centeredIconRenderSize({ icons: [{ iconId: 'x', position: 'center', size: 40 }] }, 100, 100)).toBe(40);
    // Ambiguous multi-icon → no auto-offset.
    expect(
      centeredIconRenderSize(
        { icons: [{ iconId: 'a', position: 'center' }, { iconId: 'b', position: 'top-left' }] },
        100,
        100
      )
    ).toBeNull();
  });
});
