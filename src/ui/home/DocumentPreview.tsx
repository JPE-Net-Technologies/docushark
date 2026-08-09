/**
 * DocumentPreview (JP-477) — the shared thumbnail surface for a document card.
 *
 * Extracted from `RecentCard` when the browser's grid cards needed the same
 * preview. Deliberately one implementation rather than two: a parallel renderer
 * with no shared boundary is how the canvas/prose placeholders would drift into
 * saying different things about the same document on the same screen.
 *
 * The thumbnail itself comes from `recentThumbnails` — a local-only ladder
 * (in-memory → localStorage → IndexedDB cache) that never hits the network, so
 * a document whose content isn't on this device gets a placeholder instead of a
 * spinner or a fetch.
 */

import { useEffect, useState } from 'react';
import type { DocumentRecord } from '../../types/DocumentRegistry';
import { useThemeStore } from '../../store/themeStore';
import { getRecentPreview, type RecentPreview } from './recentThumbnails';
import './DocumentPreview.css';

/** Dotted-canvas placeholder with a few node chips — reads as "a diagram". */
export function CanvasPlaceholder() {
  return (
    <span className="dh-rcard-ph dh-rcard-ph--canvas" aria-hidden="true">
      <svg className="dh-rcard-ph-edges" viewBox="0 0 100 60" preserveAspectRatio="none">
        <path d="M28 20 C 44 20, 48 34, 62 36" />
        <path d="M30 44 C 44 44, 52 40, 62 38" />
      </svg>
      <span className="dh-rcard-ph-node dh-rcard-ph-node--a" />
      <span className="dh-rcard-ph-node dh-rcard-ph-node--b" />
      <span className="dh-rcard-ph-node dh-rcard-ph-node--c" />
    </span>
  );
}

/** Skeleton text lines — reads as "a written document". */
export function DocPlaceholder() {
  return (
    <span className="dh-rcard-ph dh-rcard-ph--doc" aria-hidden="true">
      <span className="dh-rcard-ph-line dh-rcard-ph-line--title" />
      <span className="dh-rcard-ph-line" />
      <span className="dh-rcard-ph-line" />
      <span className="dh-rcard-ph-line dh-rcard-ph-line--short" />
    </span>
  );
}

/**
 * Resolve a document's mini preview, re-rendering when the document changes or
 * the surface theme flips (AUTO-coloured shapes resolve their ink against it).
 *
 * `enabled` gates the work, not the hook: a card that isn't showing a preview
 * (list and compact modes) must still call this to keep hook order stable, but
 * shouldn't pay to read the document body and rasterize it.
 */
export function useDocumentPreview(
  record: DocumentRecord,
  enabled = true,
): RecentPreview | null {
  const [preview, setPreview] = useState<RecentPreview | null>(null);
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void getRecentPreview(record, resolvedTheme).then((p) => {
      if (!cancelled) setPreview(p);
    });
    return () => {
      cancelled = true;
    };
    // Re-render only when the doc actually changed (id or edit time), the
    // surface theme flipped, or the card started needing a preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.id, record.modifiedAt, resolvedTheme, enabled]);

  return enabled ? preview : null;
}

/** The preview image, or the placeholder that matches the document's kind. */
export function DocumentPreview({ preview }: { preview: RecentPreview | null }) {
  if (preview?.uri) {
    return <img className="dh-rcard-thumb" src={preview.uri} alt="" loading="lazy" />;
  }
  return preview?.kind === 'doc' ? <DocPlaceholder /> : <CanvasPlaceholder />;
}

export default DocumentPreview;
