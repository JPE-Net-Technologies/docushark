/**
 * Paper Mode's control (DSK-48, DSK-257): an on/off switch, with PDF beside it
 * while it's on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';
import { PaperModeToggle } from './PaperModeToggle';

vi.mock('../../paper/usePaperMode', () => ({ usePaperModeAvailable: () => true }));

const paperSwitch = () => screen.getByRole('switch', { name: /Paper/ });

beforeEach(() => useUIPreferencesStore.setState({ paperMode: false }));
afterEach(cleanup);

describe('the Paper Mode control', () => {
  it('is a switch that turns Paper Mode on and off', () => {
    render(<PaperModeToggle />);
    expect(paperSwitch().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(paperSwitch());
    expect(useUIPreferencesStore.getState().paperMode).toBe(true);
    expect(paperSwitch().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(paperSwitch());
    expect(useUIPreferencesStore.getState().paperMode).toBe(false);
  });

  it('offers PDF only while Paper Mode is on, and opens the export', () => {
    render(<PaperModeToggle />);
    expect(screen.queryByRole('button', { name: /PDF/ })).toBeNull();
    fireEvent.click(paperSwitch());
    const opened = vi.fn();
    window.addEventListener('docushark:open-pdf-export', opened);
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }));
    window.removeEventListener('docushark:open-pdf-export', opened);
    expect(opened).toHaveBeenCalledTimes(1);
  });
});
