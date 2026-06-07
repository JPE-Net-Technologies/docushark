import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppearanceSettings } from './AppearanceSettings';

describe('AppearanceSettings', () => {
  it('renders the theme, accent, and motion controls', () => {
    render(<AppearanceSettings />);
    expect(screen.getByRole('radiogroup', { name: 'Color theme' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Accent color' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Interface animations' })).toBeTruthy();
  });

  // JP-107 regression: the DocuShark title-bar control is desktop-only. In the
  // test (web) environment `windowControls.isSupported()` is false (IS_TAURI is
  // false), so the entire Title bar section — header included — must be absent.
  it('does not render the title-bar section on the web app', () => {
    render(<AppearanceSettings />);
    expect(screen.queryByText(/use docushark's title bar/i)).toBeNull();
    expect(screen.queryByText('Title bar')).toBeNull();
  });
});
