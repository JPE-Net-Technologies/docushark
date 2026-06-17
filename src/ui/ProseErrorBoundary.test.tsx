/**
 * ProseErrorBoundary — never-blank proof (JP-328, supersedes the JP-319 blank
 * panel). A child that throws during render must:
 *   - never propagate and unmount the app (containment), and
 *   - with a `fallbackHtml` projection, render that content read-only (NOT an
 *     empty panel) so the user always sees their prose, and
 *   - auto-reset when `resetKeys` change so navigating to another document
 *     recovers without a reload.
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

  it('contains a render crash and shows a recoverable banner', () => {
    render(
      <ProseErrorBoundary resetKeys={['doc-1']}>
        <Boom />
      </ProseErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /reload/i })).toBeTruthy();
  });

  it('NEVER blanks: a crash with fallbackHtml shows the content read-only', async () => {
    render(
      <ProseErrorBoundary resetKeys={['doc-1']} fallbackHtml="<p>recovered prose body</p>">
        <Boom />
      </ProseErrorBoundary>,
    );
    // The recovery banner is present...
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/read-only copy/i)).toBeTruthy();
    // ...AND the user's content is rendered (ProsePreview), never a blank panel.
    expect(await screen.findByText('recovered prose body')).toBeTruthy();
  });

  it('auto-resets when resetKeys change (e.g. switching documents)', () => {
    const { rerender } = render(
      <ProseErrorBoundary resetKeys={['doc-1']} fallbackHtml="<p>doc one body</p>">
        <Boom />
      </ProseErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();

    // Switching to a different, healthy document must recover without a reload.
    rerender(
      <ProseErrorBoundary resetKeys={['doc-2']} fallbackHtml="<p>doc two body</p>">
        <Safe label="other doc" />
      </ProseErrorBoundary>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('other doc')).toBeTruthy();
  });
});
