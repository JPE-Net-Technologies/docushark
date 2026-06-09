import { describe, it, expect } from 'vitest';
import { iconOnlyRenderSize, iconOnlyLabelOffsetY } from './iconRenderer';

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
