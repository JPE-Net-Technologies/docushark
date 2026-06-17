/**
 * ProseErrorBoundary containment proof (JP-319): a child that throws during
 * render must degrade to the recoverable fallback (not propagate and unmount
 * the app), and the boundary must auto-reset when `resetKeys` change so
 * navigating to another document recovers.
 */

import { render, screen } from '@testing-library/react';
import { ProseErrorBoundary } from './ProseErrorBoundary';

function Boom(): JSX.Element {
  throw new Error('simulated prose node crash: reading "children"');
}

function Safe({ label }: { label: string }): JSX.Element {
  return <div>{label}</div>;
}

describe('ProseErrorBoundary', () => {
  // React logs caught errors to console.error; silence it for these cases.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children when they do not throw', () => {
    render(
      <ProseErrorBoundary resetKeys={['doc-1']}>
        <Safe label="prose ok" />
      </ProseErrorBoundary>,
    );
    expect(screen.getByText('prose ok')).toBeTruthy();
  });

  it('contains a render crash and shows a recoverable fallback', () => {
    render(
      <ProseErrorBoundary resetKeys={['doc-1']}>
        <Boom />
      </ProseErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/couldn.t be displayed/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('auto-resets when resetKeys change (e.g. switching documents)', () => {
    const { rerender } = render(
      <ProseErrorBoundary resetKeys={['doc-1']}>
        <Boom />
      </ProseErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();

    // Switching to a different, healthy document must recover without a reload.
    rerender(
      <ProseErrorBoundary resetKeys={['doc-2']}>
        <Safe label="other doc" />
      </ProseErrorBoundary>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('other doc')).toBeTruthy();
  });
});
