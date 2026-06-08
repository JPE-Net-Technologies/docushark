import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Slider } from './Slider';

describe('Slider', () => {
  it('exposes an accessible slider with the current value', () => {
    render(<Slider ariaLabel="Interface size" value={110} onValueChange={() => {}} min={90} max={125} step={5} />);
    const slider = screen.getByRole('slider', { name: 'Interface size' });
    expect(slider.getAttribute('aria-valuenow')).toBe('110');
  });

  it('moves on keyboard input and reports the new value', () => {
    const onValueChange = vi.fn();
    render(<Slider ariaLabel="Interface size" value={100} onValueChange={onValueChange} min={90} max={125} step={5} />);
    const slider = screen.getByRole('slider', { name: 'Interface size' });
    slider.focus();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onValueChange).toHaveBeenCalledWith(105);
  });
});
