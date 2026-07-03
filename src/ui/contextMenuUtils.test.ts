import { describe, it, expect } from 'vitest';
import { clampToViewport, placeFlyout } from './contextMenuUtils';

describe('clampToViewport', () => {
  it('keeps an in-bounds menu where it is', () => {
    expect(clampToViewport(100, 100, 180, 200)).toEqual({ x: 100, y: 100 });
  });

  it('pulls a menu in from the right and bottom edges', () => {
    // jsdom default viewport is 1024x768.
    const { x, y } = clampToViewport(2000, 2000, 180, 200);
    expect(x).toBe(1024 - 180 - 8);
    expect(y).toBe(768 - 200 - 8);
  });
});

describe('placeFlyout', () => {
  const VW = 1000;
  const VH = 800;
  const vp = { viewportWidth: VW, viewportHeight: VH, padding: 8, gap: 4 };

  // A parent menu sitting comfortably mid-screen.
  const parent = { left: 200, right: 380 };
  const anchor = { top: 250, bottom: 280, left: 200, right: 380 };

  describe('horizontal (hybrid)', () => {
    it('opens to the right when there is room', () => {
      const p = placeFlyout(anchor, parent, { width: 160, height: 200 }, vp);
      expect(p.side).toBe('right');
      expect(p.parentShift).toBe(0);
      expect(p.x).toBe(parent.right + 4); // 384
    });

    it('shifts the parent left when the right is tight but the parent can move', () => {
      const tightParent = { left: 700, right: 880 };
      const p = placeFlyout(
        { ...anchor, left: 700, right: 880 },
        tightParent,
        { width: 160, height: 200 },
        vp,
      );
      // rightX=884, +160=1044, limit=992 → overflow 52; parent can move 692.
      expect(p.side).toBe('right');
      expect(p.parentShift).toBe(52);
      expect(p.x).toBe(884 - 52); // submenu rides the shifted parent
    });

    it('flips to the left when a wide submenu cannot fit right even after shifting', () => {
      const rightParent = { left: 800, right: 1000 };
      const p = placeFlyout(
        { ...anchor, left: 800, right: 1000 },
        rightParent,
        { width: 782, height: 200 },
        vp,
      );
      // rightX=1004, +782 overflows by 794; max parent shift is 792 → can't.
      // leftX = 800 - 4 - 782 = 14 >= 8 → clean flip to the left.
      expect(p.side).toBe('left');
      expect(p.parentShift).toBe(0);
      expect(p.x).toBe(14);
    });

    it('clamps into the viewport when neither side fits (very narrow)', () => {
      const narrowVp = { viewportWidth: 360, viewportHeight: 640, padding: 8, gap: 4 };
      const p = placeFlyout(
        { top: 100, bottom: 130, left: 40, right: 320 },
        { left: 40, right: 320 },
        { width: 280, height: 200 },
        narrowVp,
      );
      expect(p.x).toBeGreaterThanOrEqual(8);
      expect(p.x + 280).toBeLessThanOrEqual(360); // never spills off either edge
    });
  });

  describe('vertical (align + clamp + scroll)', () => {
    it('aligns to the anchor top when it fits', () => {
      const p = placeFlyout(anchor, parent, { width: 160, height: 200 }, vp);
      expect(p.y).toBe(250);
      expect(p.maxHeight).toBe(200);
    });

    it('shifts up so the bottom stays on-screen', () => {
      const lowAnchor = { top: 700, bottom: 730, left: 200, right: 380 };
      const p = placeFlyout(lowAnchor, parent, { width: 160, height: 300 }, vp);
      expect(p.y).toBe(VH - 8 - 300); // 492 — pulled up so it fits
      expect(p.maxHeight).toBe(300); // still no scroll
    });

    it('caps height and enables scroll when taller than the viewport', () => {
      const p = placeFlyout(anchor, parent, { width: 160, height: 2000 }, vp);
      expect(p.maxHeight).toBe(VH - 2 * 8); // 784
      expect(p.y).toBe(8); // pinned to the top padding
    });

    it('never lets y go above the top padding', () => {
      const highAnchor = { top: 2, bottom: 30, left: 200, right: 380 };
      const p = placeFlyout(highAnchor, parent, { width: 160, height: 200 }, vp);
      expect(p.y).toBe(8);
    });
  });
});
