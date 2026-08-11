/**
 * RecentCard (JP-444) — one "Continue working" card: a preview area (real
 * canvas mini-thumbnail when the doc's content is locally available, else a
 * stylized placeholder) over a title + mono meta strip. The card's accent
 * (placeholder chips, hover edge) picks up the doc's collection color.
 */
import type { CSSProperties } from 'react';
import type { DocumentRecord } from '../../types/DocumentRegistry';
import { formatDate } from '../DocumentCard';
import { DocumentPreview, useDocumentPreview } from './DocumentPreview';

function sourceLabel(record: DocumentRecord): string {
  switch (record.type) {
    case 'local':
      return 'Local';
    case 'cached':
      return 'Offline';
    case 'remote':
      return 'Cloud';
    case 'external':
      return 'Shared';
  }
}

export interface RecentCardProps {
  record: DocumentRecord;
  /** Collection accent for the preview (name for tooltip, color for tint). */
  accent?: { name: string; color?: string | undefined } | undefined;
  onOpen: () => void;
}

export function RecentCard({ record, accent, onOpen }: RecentCardProps) {
  const preview = useDocumentPreview(record);

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
        <DocumentPreview preview={preview} />
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
