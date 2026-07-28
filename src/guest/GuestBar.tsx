/**
 * Guest header bar (JP-464) — the one piece of chrome a share-link reader
 * always sees. Identity (this is a DocuShark document), provenance (name +
 * published date, the line a citation wants), and the two actions a reader
 * can take without an account: keep a copy of the data, or try the product.
 *
 * Deliberately not a sign-up wall: reading never prompts for anything. The
 * document is the pitch.
 */
import { Download, ExternalLink } from 'lucide-react';
import { useDocumentRegistry } from '../store/documentRegistry';
import { useGuestStore } from './guestSession';
import './guest.css';

function formatPublished(ms: number): string {
  if (!ms) return '';
  const date = new Date(ms);
  return date.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

/** Download the rendered snapshot as a JSON file — the reader keeps the data
 *  with no account and no server round-trip (the document is already here). */
function downloadSnapshot(name: string, docId: string | null): void {
  if (!docId) return;
  const doc = useDocumentRegistry.getState().entries[docId]?.document;
  if (!doc) return;
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[^\w.-]+/g, '_') || 'document'}.docushark.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function GuestBar() {
  const documentName = useGuestStore((s) => s.documentName);
  const publishedAt = useGuestStore((s) => s.publishedAt);
  const activeDocId = useDocumentRegistry((s) => s.activeDocumentId);
  const published = formatPublished(publishedAt);

  return (
    <header className="guest-bar" role="banner">
      <div className="guest-bar__identity">
        <span className="guest-bar__brand">DocuShark</span>
        <span className="guest-bar__divider" aria-hidden="true" />
        <span className="guest-bar__name" title={documentName}>
          {documentName}
        </span>
        {published ? (
          <span className="guest-bar__published">Published {published}</span>
        ) : null}
      </div>
      <div className="guest-bar__actions">
        <button
          type="button"
          className="guest-bar__btn"
          onClick={() => downloadSnapshot(documentName, activeDocId)}
          title="Download this document's data as JSON"
        >
          <Download size={14} aria-hidden="true" />
          <span>Download copy</span>
        </button>
        <a
          className="guest-bar__btn guest-bar__btn--cta"
          href="/"
          target="_blank"
          rel="noopener"
          title="Open DocuShark and start your own document — free"
        >
          <ExternalLink size={14} aria-hidden="true" />
          <span>Try DocuShark free</span>
        </a>
      </div>
    </header>
  );
}

export default GuestBar;
