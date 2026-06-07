import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppearanceSettings } from './AppearanceSettings';

describe('AppearanceSettings', () => {
  it('renders the theme control', () => {
    render(<AppearanceSettings />);
    expect(screen.getByRole('radiogroup', { name: 'Color theme' })).toBeTruthy();
  });

  // JP-107 regression: the custom-window-chrome control is desktop-only. In the
  // test (web) environment `windowControls.isSupported()` is false (IS_TAURI is
  // false), so the entire Window section — header included — must be absent.
  it('does not render the window-chrome section on web', () => {
    render(<AppearanceSettings />);
    expect(screen.queryByText(/custom window chrome/i)).toBeNull();
    expect(screen.queryByText('Window')).toBeNull();
  });
});
