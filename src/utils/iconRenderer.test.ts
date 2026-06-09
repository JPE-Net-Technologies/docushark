import { describe, it, expect } from 'vitest';
import { getIconOnlySize, iconOnlyLabelOffsetY } from './iconRenderer';

describe('getIconOnlySize', () => {
  it('reads the legacy iconSize, defaulting to 24', () => {
    expect(getIconOnlySize({ iconSize: 48 })).toBe(48);
    expect(getIconOnlySize({})).toBe(24);
  });

  it('reads the icon-only entry from a multi-icon array', () => {
    expect(
      getIconOnlySize({ icons: [{ iconId: 'x', position: 'center', displayMode: 'icon-only', size: 40 }] })
    ).toBe(40);
  });
});

describe('iconOnlyLabelOffsetY', () => {
  it('drops the label below the centred icon, sticky to the icon size', () => {
    // iconSize/2 clears the icon's bottom edge, + one label line for a gap.
    expect(iconOnlyLabelOffsetY({ iconSize: 24 }, 14)).toBe(12 + 14);
    expect(iconOnlyLabelOffsetY({ iconSize: 48 }, 14)).toBe(24 + 14);
  });

  it('tracks the default icon size when none is set', () => {
    expect(iconOnlyLabelOffsetY({}, 12)).toBe(12 + 12); // default size 24 → /2 = 12
  });

  it('is always positive (below centre), never overlapping', () => {
    expect(iconOnlyLabelOffsetY({ iconSize: 16 }, 10)).toBeGreaterThan(0);
  });
});
