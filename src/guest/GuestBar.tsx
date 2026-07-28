/**
 * Guest header bar (JP-464) — the one piece of chrome a share-link reader
 * always sees. Identity (this is a DocuShark document), provenance (name +
 * published date, the line a citation wants), and one forward action.
 *
 * Deliberately not a sign-up wall: reading never prompts for anything. The
 * document is the pitch.
 *
 * **No "take a copy" action here, on purpose (JP-467).** A copy is only
 * useful as a `.docushark` archive — document *plus* its blob bytes — and
 * handing that to an anonymous reader is a distribution decision, not a
 * button. The right shape is **Add to Workspace**: sign in, and the document
 * lands in a workspace you own, where the archive machinery already works.
 * Until that exists, offering a download would either emit JSON full of
 * dangling `blob://` references or quietly publish a full archive.
 */
import { ExternalLink } from 'lucide-react';
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

export function GuestBar() {
  const documentName = useGuestStore((s) => s.documentName);
  const publishedAt = useGuestStore((s) => s.publishedAt);
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
