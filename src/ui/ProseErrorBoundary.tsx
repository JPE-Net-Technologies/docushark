/**
 * ProseErrorBoundary — guarantees a prose page is **never blank** when the live
 * editor crashes (JP-328, Pillar 1b; supersedes the JP-319 blank-panel fallback).
 *
 * The prose editors render a ProseMirror/Tiptap node tree via ReactNodeViews. A
 * node the client schema can't reconcile (historically a malformed node from the
 * relay seed path — e.g. a src-less `image` atom) makes ProseMirror's desc-tree
 * walk throw "Cannot read properties of undefined (reading 'children')" *during
 * render*, which without a boundary unmounts the entire React tree.
 *
 * Catching that crash is not enough — an empty panel is still broken. So when a
 * `fallbackHtml` is supplied (the page's stored HTML projection from
 * `richTextPages`), the boundary renders it read-only through `ProsePreview`
 * instead: the user always sees their content. `ProsePreview` loads HTML via
 * ProseMirror's lenient `DOMParser` (fits-to-schema, never throws), so it is the
 * always-safe representation when the live Y.Doc fragment is suspect. A small
 * non-blocking banner offers Retry / Reload.
 *
 * Scope: a React boundary catches render/lifecycle crashes (the observed open-doc
 * case) — not errors thrown inside an async y-prosemirror sync callback. Post-mount
 * sync-time corruption is prevented *upstream* by the relay write gate (JP-328),
 * so malformed data never reaches the fragment; the two layers compose to full
 * coverage. Auto-resets when `resetKeys` change (a document / page switch).
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ProsePreview } from './ProsePreview';

interface ProseErrorBoundaryProps {
  /**
   * When any entry changes between renders, the boundary clears its error and
   * retries its children — pass `[docId, pageId]` so switching documents/pages
   * recovers automatically.
   */
  resetKeys?: ReadonlyArray<unknown>;
  /**
   * The page's stored HTML projection. When present, a caught crash degrades to
   * this content rendered read-only (never blank). When absent, the boundary
   * shows a generic recoverable panel.
   */
  fallbackHtml?: string;
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

    const { fallbackHtml } = this.props;

    // Recovery banner (Pillar 1c) — non-blocking, sits above the content.
    const banner = (
      <div
        role="alert"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'wrap',
          margin: '0 0 0.75rem',
          padding: '0.6rem 0.9rem',
          border: '1px solid var(--border-color, #d0c8ba)',
          borderRadius: '8px',
          background: 'var(--surface-2, rgba(0,0,0,0.03))',
          color: 'var(--text-color, inherit)',
          fontSize: '0.9em',
        }}
      >
        <span style={{ flex: '1 1 16rem' }}>
          {fallbackHtml !== undefined
            ? 'Showing a read-only copy — the live editor couldn’t load this page.'
            : 'This page’s editor hit an unexpected error and was contained.'}
        </span>
        <span style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="button" onClick={this.reset}>
            Try again
          </button>
          <button type="button" onClick={this.reload}>
            Reload
          </button>
        </span>
      </div>
    );

    // The guarantee (Pillar 1b): with a fallback projection, never blank — show
    // the content read-only. ProsePreview parses HTML leniently, so it renders
    // even content the live fragment couldn't. The wrapper is a height-filling
    // flex column with `min-height: 0` so the preview's `.tiptap-editor` keeps a
    // bounded track and actually scrolls (a plain wrapper broke the flex chain).
    if (fallbackHtml !== undefined) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          {banner}
          <ProsePreview html={fallbackHtml || '<p></p>'} />
        </div>
      );
    }

    // No projection to fall back to — a recoverable panel (the legacy floor).
    return (
      <div style={{ margin: '2rem auto', maxWidth: '36rem' }}>
        {banner}
      </div>
    );
  }
}

export default ProseErrorBoundary;
