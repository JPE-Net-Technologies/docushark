import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ColorPicker, type ColorSpecial } from './ColorPicker';
import { useColorPaletteStore } from '../../store/colorPaletteStore';

afterEach(cleanup);
beforeEach(() => useColorPaletteStore.getState().reset());

const hexField = () => screen.getByLabelText('Hex color') as HTMLInputElement;

describe('ColorPicker hex field', () => {
  it('seeds from the current value rather than a stored default', () => {
    // The old palette showed a global "custom colour" here, so the panel could
    // read #48bb78 while the picker's field read something unrelated.
    render(<ColorPicker value="#48bb78" onChange={() => {}} />);
    expect(hexField().value).toBe('#48bb78');
  });

  it('follows the value when it changes from outside', () => {
    const { rerender } = render(<ColorPicker value="#48bb78" onChange={() => {}} />);
    rerender(<ColorPicker value="#ff6600" onChange={() => {}} />);
    expect(hexField().value).toBe('#ff6600');
  });

  it('commits a bare hex typed without the leading hash', () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#000000" onChange={onChange} />);
    fireEvent.change(hexField(), { target: { value: 'ff6600' } });
    fireEvent.blur(hexField());
    expect(onChange).toHaveBeenCalledWith('#ff6600');
  });

  it('does not re-insert the hash while editing', () => {
    // The reported annoyance: the old field force-prepended `#` on every
    // keystroke, so the character could never be deleted.
    render(<ColorPicker value="#ff6600" onChange={() => {}} />);
    const field = hexField();
    fireEvent.change(field, { target: { value: 'ff6600' } });
    expect(field.value).toBe('ff6600');
    fireEvent.change(field, { target: { value: 'ff660' } });
    expect(field.value).toBe('ff660');
  });

  it('accepts a pasted rgb() string and stores canonical hex', () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#000000" onChange={onChange} />);
    fireEvent.change(hexField(), { target: { value: 'rgb(255, 102, 0)' } });
    fireEvent.blur(hexField());
    expect(onChange).toHaveBeenCalledWith('#ff6600');
  });

  it('commits on Enter', () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#000000" onChange={onChange} />);
    fireEvent.change(hexField(), { target: { value: '#123456' } });
    fireEvent.keyDown(hexField(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('#123456');
  });

  it('marks invalid input instead of silently reverting it', () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#ff6600" onChange={onChange} />);
    const field = hexField();
    fireEvent.change(field, { target: { value: 'nonsense' } });
    fireEvent.blur(field);

    expect(onChange).not.toHaveBeenCalled();
    // The text the user typed is still there to be corrected, and is flagged.
    expect(field.value).toBe('nonsense');
    expect(field.getAttribute('aria-invalid')).toBe('true');
  });

  it('restores the current value on Escape', () => {
    render(<ColorPicker value="#ff6600" onChange={() => {}} />);
    const field = hexField();
    fireEvent.change(field, { target: { value: 'garbage' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field.value).toBe('#ff6600');
  });
});

describe('ColorPicker specials', () => {
  it('calls the surface’s own callback and never invents a value', () => {
    // The correctness trap: canvas "Automatic" is the stored string 'auto',
    // but in prose "Default" is the *absence* of a mark. If the picker wrote a
    // shared sentinel, 'auto' would leak into prose HTML and the schema
    // contract. It must only ever call back.
    const onSelect = vi.fn();
    const onChange = vi.fn();
    const specials: ColorSpecial[] = [
      { id: 'default', label: 'Default', swatch: 'auto', isActive: false, onSelect },
    ];
    render(<ColorPicker value="#ff6600" onChange={onChange} specials={specials} />);

    fireEvent.click(screen.getByLabelText('Default'));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('marks the active special', () => {
    const specials: ColorSpecial[] = [
      { id: 'none', label: 'No fill', swatch: 'none', isActive: true, onSelect: () => {} },
    ];
    render(<ColorPicker value="" onChange={() => {}} specials={specials} />);
    expect(screen.getByLabelText('No fill').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('ColorPicker presets', () => {
  it('leads table surfaces with neutrals, which the highlight palette lacked', () => {
    render(<ColorPicker value="" onChange={() => {}} preset="document" />);
    const labels = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    expect(labels[0]).toBe('Neutrals');
    expect(labels).toContain('Palette');
    // A usable header-row grey must actually be offered. (It appears in both
    // Neutrals and the Slate ramp, which is fine — hence getAll.)
    expect(screen.getAllByLabelText('#f1f5f9').length).toBeGreaterThan(0);
  });

  it('always labels its sections, including in compact mode', () => {
    // Compact previously suppressed every label, leaving the property panel
    // showing unexplained rows of swatches.
    render(<ColorPicker value="#ff6600" onChange={() => {}} compact />);
    expect(screen.getAllByRole('heading', { level: 4 }).length).toBeGreaterThan(0);
  });
});

describe('ColorPicker swatches', () => {
  it('commits a swatch click as a canonical hex', () => {
    const onChange = vi.fn();
    render(<ColorPicker value="" onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('#ef4444'));
    expect(onChange).toHaveBeenCalledWith('#ef4444');
  });

  it('records chosen colours as recents', () => {
    render(<ColorPicker value="" onChange={() => {}} />);
    fireEvent.click(screen.getByLabelText('#ef4444'));
    expect(useColorPaletteStore.getState().recentColors).toContain('#ef4444');
  });

  it('exposes the grid as a single tab stop with arrow-key navigation', () => {
    // ~60 sequential tab stops is not a usable keyboard surface.
    render(<ColorPicker value="" onChange={() => {}} />);
    const focusable = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-cell') !== null && b.tabIndex === 0);
    expect(focusable).toHaveLength(1);
  });
});

describe('ColorPicker variations', () => {
  it('does not repeat a swatch when the ramp clamps at an extreme', () => {
    // Found live: white lightened is still white, so the naive five-step ramp
    // rendered #ffffff three times — visible as duplicate-key warnings and
    // three identical, pointless swatches.
    render(<ColorPicker value="#ffffff" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));

    const labels = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'))
      .filter((l): l is string => l === '#ffffff');
    // One in the Neutrals row, one in Variations — never three in a row.
    expect(labels.length).toBeLessThanOrEqual(2);
  });
});

describe('ColorPicker contrast readout', () => {
  it('reports a failing pairing against the given background', () => {
    render(<ColorPicker value="#fefce8" onChange={() => {}} contrastAgainst="#ffffff" />);
    expect(screen.getByText(/Fail/)).toBeTruthy();
  });

  it('reports a passing pairing', () => {
    render(<ColorPicker value="#0f172a" onChange={() => {}} contrastAgainst="#ffffff" />);
    expect(screen.getByText(/AAA/)).toBeTruthy();
  });

  it('stays out of the way when no background is supplied', () => {
    render(<ColorPicker value="#0f172a" onChange={() => {}} />);
    expect(screen.queryByText(/AAA|AA|Fail/)).toBeNull();
  });
});
