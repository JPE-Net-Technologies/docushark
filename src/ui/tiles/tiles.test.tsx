import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';
import { Maximize, Rows3, Smartphone } from 'lucide-react';
import { FillTile, SegmentedTile, ToggleTile } from './Tile';

// Vite's test transform rewrites `import.meta.url` to a non-file scheme, so
// resolve from the project root (vitest's cwd) instead.
const readSrc = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');
const CSS = readSrc('src/ui/tiles/tiles.css');
/** Declarations only. The comments in this file discuss the very properties the
 *  guards below forbid, so matching raw source would fail on the prose. */
const CSS_DECLS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declaration block for a selector, so an assertion can't be satisfied by
 *  an unrelated rule elsewhere in the file. */
function ruleBody(selector: string): string {
  const at = CSS_DECLS.indexOf(selector);
  if (at === -1) throw new Error(`selector not found in tiles.css: ${selector}`);
  const open = CSS_DECLS.indexOf('{', at);
  const close = CSS_DECLS.indexOf('}', open);
  return CSS_DECLS.slice(open + 1, close);
}

/**
 * CSS contract.
 *
 * These are deliberately **source** assertions, not layout assertions. All three
 * defects below were found by measuring a real browser, and jsdom has no layout
 * engine — `scrollWidth`, `clientWidth` and resolved geometry are all stubbed to
 * 0, so a test asserting "the control is not clipped" here would pass whether or
 * not it actually was. Guarding the CSS decision that caused each defect is the
 * honest thing a unit test can do; the geometry itself is re-checked in the
 * browser (see the verification steps on the PR).
 */
describe('tiles.css contract', () => {
  it('sizes grid rows with a floor, not a fixed height', () => {
    // A constant row height clipped every segmented control by 14px: chip (30) +
    // gap + control (30) + padding (20) exceeds it, and all of those move again
    // with --density-mult and --ui-scale.
    const grid = ruleBody('.tile-grid {');
    expect(grid).toMatch(/grid-auto-rows:\s*minmax\(/);
    expect(grid).not.toMatch(/grid-auto-rows:\s*var\(--tile-row\)\s*;/);
  });

  it('never puts backdrop-filter on a tile', () => {
    // backdrop-filter costs a backdrop read-back + blur pass per element, and a
    // nested one re-blurs its already-blurred parent. Measured: 2 blur surfaces
    // = 7.15ms/frame, 32 = 9.46ms/frame, for no visible difference. The sheet
    // blurs once; tiles are plain translucent fills over it.
    expect(CSS_DECLS).not.toMatch(/backdrop-filter/);
  });

  it('wipes the toggle bloom with clip-path, never a transform', () => {
    // A transformed/oversized absolutely-positioned child extends the tile's
    // scrollable overflow rectangle. `overflow: hidden` hides the scrollbar but
    // does not remove the scroll — setting scrollLeft really did shunt tile
    // content 195px sideways, and only while the toggle was on.
    const bloom = ruleBody('.tile--toggle::before {');
    expect(bloom).toMatch(/clip-path:\s*circle\(/);
    expect(bloom).not.toMatch(/transform:/);
  });

  it('keeps the container queries below the rules they override', () => {
    // Container queries carry no specificity bump, so they win by source order
    // alone. Hoisting this block above the base rules silently breaks reflow.
    expect(CSS_DECLS.indexOf('@container')).toBeGreaterThan(CSS_DECLS.indexOf('.tile--w2 {'));
    expect(CSS_DECLS.indexOf('@container')).toBeGreaterThan(CSS_DECLS.indexOf('.tile--fill {'));
  });
});

describe('ToggleTile', () => {
  it('exposes switch semantics rather than a plain button', () => {
    render(
      <ToggleTile icon={Smartphone} label="Mobile preview" checked onCheckedChange={() => {}} />
    );
    const el = screen.getByRole('switch', { name: 'Mobile preview' });
    expect(el.getAttribute('aria-checked')).toBe('true');
  });

  it('toggles to the opposite of its current value', () => {
    const onCheckedChange = vi.fn();
    render(
      <ToggleTile
        icon={Smartphone}
        label="Mobile preview"
        checked={false}
        onCheckedChange={onCheckedChange}
      />
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Mobile preview' }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('shows the state word, and a note when one is given', () => {
    const { rerender } = render(
      <ToggleTile icon={Smartphone} label="Mobile preview" checked onCheckedChange={() => {}} />
    );
    expect(screen.getByText('On')).toBeTruthy();

    rerender(
      <ToggleTile
        icon={Smartphone}
        label="Properties"
        checked={false}
        onCheckedChange={() => {}}
        note="on selection"
      />
    );
    expect(screen.getByText('on selection')).toBeTruthy();
  });

  it('does not fire when disabled', () => {
    const onCheckedChange = vi.fn();
    render(
      <ToggleTile
        icon={Smartphone}
        label="Properties"
        checked={false}
        onCheckedChange={onCheckedChange}
        disabled
      />
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Properties' }));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});

describe('SegmentedTile', () => {
  const OPTIONS = [
    { value: 'compact', label: 'Compact' },
    { value: 'normal', label: 'Normal' },
    { value: 'spacious', label: 'Spacious' },
  ] as const;

  it('renders the real SegmentedControl, keeping radiogroup semantics', () => {
    const onValueChange = vi.fn();
    render(
      <SegmentedTile
        icon={Rows3}
        label="Density"
        value="normal"
        onValueChange={onValueChange}
        options={OPTIONS}
      />
    );
    expect(screen.getByRole('radio', { name: 'Normal' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Spacious' }));
    expect(onValueChange).toHaveBeenCalledWith('spacious');
  });
});

describe('FillTile', () => {
  const props = {
    icon: Maximize,
    label: 'Interface size',
    min: 75,
    max: 150,
    step: 5,
  };

  it('reports slider semantics with its current value', () => {
    render(<FillTile {...props} value={100} onValueChange={() => {}} />);
    const el = screen.getByRole('slider', { name: 'Interface size' });
    expect(el.getAttribute('aria-valuenow')).toBe('100');
    expect(el.getAttribute('aria-valuemin')).toBe('75');
    expect(el.getAttribute('aria-valuemax')).toBe('150');
  });

  it('steps with the arrow keys — the drag surface alone is not keyboard-reachable', () => {
    const onValueChange = vi.fn();
    render(<FillTile {...props} value={100} onValueChange={onValueChange} />);
    const el = screen.getByRole('slider', { name: 'Interface size' });

    fireEvent.keyDown(el, { key: 'ArrowUp' });
    expect(onValueChange).toHaveBeenLastCalledWith(105);

    fireEvent.keyDown(el, { key: 'ArrowDown' });
    expect(onValueChange).toHaveBeenLastCalledWith(95);
  });

  it('clamps at both ends rather than running past them', () => {
    const onValueChange = vi.fn();
    const { rerender } = render(<FillTile {...props} value={150} onValueChange={onValueChange} />);
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowUp' });
    expect(onValueChange).toHaveBeenLastCalledWith(150);

    rerender(<FillTile {...props} value={75} onValueChange={onValueChange} />);
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowDown' });
    expect(onValueChange).toHaveBeenLastCalledWith(75);
  });

  it('jumps to the ends with Home and End', () => {
    const onValueChange = vi.fn();
    render(<FillTile {...props} value={100} onValueChange={onValueChange} />);
    const el = screen.getByRole('slider');

    fireEvent.keyDown(el, { key: 'Home' });
    expect(onValueChange).toHaveBeenLastCalledWith(75);

    fireEvent.keyDown(el, { key: 'End' });
    expect(onValueChange).toHaveBeenLastCalledWith(150);
  });
});

describe('glass opt-out', () => {
  it('resolves every glass token back to an opaque value', () => {
    // The Appearance toggle is one attribute on <html>; there must be no second
    // styling path for components to drift against.
    const indexCss = readSrc('src/index.css');
    const off = indexCss.slice(indexCss.indexOf("[data-glass='off']"));
    const block = off.slice(0, off.indexOf('}'));
    for (const token of [
      '--glass-surface',
      '--glass-border',
      '--glass-tile',
      '--glass-tile-hover',
      '--glass-tile-border',
      '--glass-highlight',
      '--shadow-float',
      '--shadow-tile',
      '--grad-primary',
      '--grad-fill',
    ]) {
      expect(block).toContain(`${token}:`);
    }
    expect(block).toMatch(/--glass-blur:\s*0px/);
  });
});
