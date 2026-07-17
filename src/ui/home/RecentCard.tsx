/**
 * RecentCard (JP-444) — one "Continue working" card: a preview area (real
 * canvas mini-thumbnail when the doc's content is locally available, else a
 * stylized placeholder) over a title + mono meta strip. The card's accent
 * (placeholder chips, hover edge) picks up the doc's collection color.
 */
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { DocumentRecord } from '../../types/DocumentRegistry';
import { useThemeStore } from '../../store/themeStore';
import { formatDate } from '../DocumentCard';
import { getRecentPreview, type RecentPreview } from './recentThumbnails';

function sourceLabel(record: DocumentRecord): string {
  switch (record.type) {
    case 'local':
      return 'Local';
    case 'cached':
      return 'Offline';
    case 'remote':
      return 'Cloud';
  }
}

/** Dotted-canvas placeholder with a few node chips — reads as "a diagram". */
function CanvasPlaceholder() {
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
function DocPlaceholder() {
  return (
    <span className="dh-rcard-ph dh-rcard-ph--doc" aria-hidden="true">
      <span className="dh-rcard-ph-line dh-rcard-ph-line--title" />
      <span className="dh-rcard-ph-line" />
      <span className="dh-rcard-ph-line" />
      <span className="dh-rcard-ph-line dh-rcard-ph-line--short" />
    </span>
  );
}

export interface RecentCardProps {
  record: DocumentRecord;
  /** Collection accent for the preview (name for tooltip, color for tint). */
  accent?: { name: string; color?: string | undefined } | undefined;
  onOpen: () => void;
}

export function RecentCard({ record, accent, onOpen }: RecentCardProps) {
  const [preview, setPreview] = useState<RecentPreview | null>(null);
  // AUTO-coloured shapes resolve against the theme (white ink on dark) — a
  // theme flip re-renders the thumbnail with the matching ink.
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);

  useEffect(() => {
    let cancelled = false;
    void getRecentPreview(record, resolvedTheme).then((p) => {
      if (!cancelled) setPreview(p);
    });
    return () => {
      cancelled = true;
    };
    // Re-render only when the doc actually changed (id or edit time) or the
    // surface theme flipped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.id, record.modifiedAt, resolvedTheme]);

  const style = accent?.color
    ? ({ '--rcard-accent': accent.color } as CSSProperties)
    : undefined;

  return (
    <button
      className="dh-rcard"
      onClick={onOpen}
      style={style}
      title={accent ? `${record.name} — ${accent.name}` : record.name}
    >
      <span className="dh-rcard-preview">
        {preview?.uri ? (
          <img className="dh-rcard-thumb" src={preview.uri} alt="" loading="lazy" />
        ) : preview?.kind === 'doc' ? (
          <DocPlaceholder />
        ) : (
          <CanvasPlaceholder />
        )}
      </span>
      <span className="dh-rcard-meta">
        <span className="dh-rcard-title">{record.name}</span>
        <span className="dh-rcard-sub">
          {sourceLabel(record)} · {formatDate(record.modifiedAt)}
        </span>
      </span>
    </button>
  );
}

export default RecentCard;
