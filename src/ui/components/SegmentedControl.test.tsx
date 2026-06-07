import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SegmentedControl } from './SegmentedControl';

const OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;

describe('SegmentedControl', () => {
  it('renders every option', () => {
    render(
      <SegmentedControl ariaLabel="Color theme" value="system" onValueChange={() => {}} options={OPTIONS} />
    );
    expect(screen.getByText('System')).toBeTruthy();
    expect(screen.getByText('Light')).toBeTruthy();
    expect(screen.getByText('Dark')).toBeTruthy();
  });

  it('marks the selected option as checked', () => {
    render(
      <SegmentedControl ariaLabel="Color theme" value="light" onValueChange={() => {}} options={OPTIONS} />
    );
    const light = screen.getByRole('radio', { name: 'Light' });
    expect(light.getAttribute('aria-checked')).toBe('true');
  });

  it('calls onValueChange with the clicked option value', () => {
    const onValueChange = vi.fn();
    render(
      <SegmentedControl ariaLabel="Color theme" value="system" onValueChange={onValueChange} options={OPTIONS} />
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(onValueChange).toHaveBeenCalledWith('dark');
  });
});
