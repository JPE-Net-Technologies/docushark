/**
 * ProseErrorBoundary — contains a prose-editor render crash so one bad document
 * can't take down the whole app (JP-319).
 *
 * The prose editors render a ProseMirror/Tiptap node tree via ReactNodeViews.
 * A node the client schema can't reconcile (historically a malformed node from
 * the relay seed path — e.g. a src-less `image` atom) makes ProseMirror's
 * desc-tree walk throw "Cannot read properties of undefined (reading
 * 'children')" *during render*, which without a boundary unmounts the entire
 * React tree. The relay seed path is now hardened against that class, but this
 * is the defense-in-depth layer: even a novel bad node degrades to a recoverable
 * panel instead of a blank app.
 *
 * Auto-resets when `resetKeys` change (a document / page switch), so navigating
 * away from a document that failed to render recovers without a reload.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ProseErrorBoundaryProps {
  /**
   * When any entry changes between renders, the boundary clears its error and
   * retries its children — pass `[docId, pageId]` so switching documents/pages
   * recovers automatically.
   */
  resetKeys?: ReadonlyArray<unknown>;
  children: ReactNode;
}

interface ProseErrorBoundaryState {
  error: Error | null;
}

function keysChanged(a?: ReadonlyArray<unknown>, b?: ReadonlyArray<unknown>): boolean {
  if (a === b) return false;
  if (!a || !b || a.length !== b.length) return true;
  return a.some((v, i) => !Object.is(v, b[i]));
}

export class ProseErrorBoundary extends Component<
  ProseErrorBoundaryProps,
  ProseErrorBoundaryState
> {
  state: ProseErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ProseErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log for diagnostics — the component stack points at the failing node view.
    console.error('[ProseErrorBoundary] prose editor crashed (contained):', error, info.componentStack);
  }

  componentDidUpdate(prev: ProseErrorBoundaryProps): void {
    if (this.state.error && keysChanged(prev.resetKeys, this.props.resetKeys)) {
      this.setState({ error: null });
    }
  }

  private readonly reset = (): void => this.setState({ error: null });

  private readonly reload = (): void => window.location.reload();

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          margin: '2rem auto',
          maxWidth: '36rem',
          padding: '1.5rem',
          border: '1px solid var(--border-color, #d0c8ba)',
          borderRadius: '8px',
          background: 'var(--surface-2, rgba(0,0,0,0.03))',
          color: 'var(--text-color, inherit)',
          textAlign: 'center',
        }}
      >
        <p style={{ fontWeight: 600, margin: '0 0 0.5rem' }}>
          This document&rsquo;s text couldn&rsquo;t be displayed.
        </p>
        <p style={{ margin: '0 0 1rem', opacity: 0.8, fontSize: '0.9em' }}>
          The editor hit an unexpected content error and was contained, so the rest of the app
          keeps working. Switching to another document, or trying again, usually recovers.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
          <button type="button" onClick={this.reset}>
            Try again
          </button>
          <button type="button" onClick={this.reload}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}

export default ProseErrorBoundary;
