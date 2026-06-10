import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { DisplayAsIconToggle } from './DisplayAsIconToggle';

afterEach(cleanup);

describe('DisplayAsIconToggle', () => {
  it('is checked when the shape is already displayed as an icon', () => {
    render(<DisplayAsIconToggle iconId="builtin:aws-aws-lambda" displayMode="icon-only" onChange={() => {}} />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  });

  it('turns a shape into its icon (icon-only) when toggled on', () => {
    const onChange = vi.fn();
    render(<DisplayAsIconToggle iconId="builtin:aws-aws-lambda" displayMode="inside" onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith('icon-only');
  });

  it('returns to a normal shape (inside) when toggled off', () => {
    const onChange = vi.fn();
    render(<DisplayAsIconToggle iconId="builtin:aws-aws-lambda" displayMode="icon-only" onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith('inside');
  });

  it('is disabled with a hint until an icon is chosen', () => {
    const onChange = vi.fn();
    render(<DisplayAsIconToggle iconId={undefined} displayMode={undefined} onChange={onChange} />);
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(screen.getByText('pick an icon first')).toBeTruthy();
    fireEvent.click(checkbox);
    expect(onChange).not.toHaveBeenCalled();
  });
});
