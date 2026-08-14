/**
 * The inline file chip rendered for a `fileRef` prose node (JP-495).
 *
 * A React node view rather than plain DOM because the file-type icons are React
 * components (`getFileTypeLucideIcon`) — the first cut built the chip by hand
 * and produced an empty `<svg>`, so every chip rendered with a blank icon slot.
 *
 * The chip reports **state**, not just a name: a file whose bytes aren't
 * available looks different from one that opens, so a reader isn't invited to
 * click something that cannot work. That vocabulary (muted + dashed) is
 * borrowed from `.field-ref-unset` so the two inline atoms read as one system.
 */

import { useCallback, useEffect, useState } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { Download } from 'lucide-react';

import { Icon } from './icons';
import { useSessionStore } from '../store/sessionStore';
import { blobStorage } from '../storage/BlobStorage';
import { isBlobMissing, onBlobLoad } from '../storage/blobResolver';
import { downloadBlob } from '../utils/downloadUtils';
import { detectFileCategory, truncateFileNameForDisplay } from '../utils/fileUtils';
import { getFileTypeLucideIcon } from '../utils/fileTypeIcons';
import { formatFileSize } from '../utils/byteSize';
import { toBlobHash, type FileDescriptor } from './fileDescriptor';

/** Longest filename shown before the stem is truncated (the extension stays). */
const MAX_NAME_CHARS = 28;

export function FileRefChip({ node }: NodeViewProps) {
  const openFileViewerFor = useSessionStore((s) => s.openFileViewerFor);

  const blobUri = (node.attrs['blobRef'] as string) ?? '';
  const fileName = (node.attrs['fileName'] as string) ?? '';
  const mimeType = (node.attrs['mimeType'] as string) ?? '';
  const rawSize = (node.attrs['fileSize'] as string) ?? '';

  const hash = toBlobHash(blobUri);
  const size = Number(rawSize);
  const hasSize = Number.isFinite(size) && size > 0;

  // Derived, never persisted — a stored category can drift from its mime.
  const category = detectFileCategory(mimeType, fileName);
  const FileIcon = getFileTypeLucideIcon(category);

  const [missing, setMissing] = useState(() => isBlobMissing(hash) === true);
  const [busy, setBusy] = useState(false);

  // `isBlobMissing` is a cache peek, so re-check when the blob layer reports a
  // change — a chip that was unavailable offline should recover on its own once
  // the bytes arrive, without the reader reloading.
  useEffect(() => {
    setMissing(isBlobMissing(hash) === true);
    return onBlobLoad(() => setMissing(isBlobMissing(hash) === true));
  }, [hash]);

  const open = useCallback(() => {
    if (!hash) return;
    const descriptor: FileDescriptor = {
      blobRef: hash,
      fileName,
      mimeType,
      fileSize: hasSize ? size : 0,
      fileCategory: category,
      // Keyed by content: the same attachment resumes where the reader left it,
      // and a chip has no durable id of its own to key on.
      sourceId: hash,
      // No onReplace/onRecover — prose has nowhere to write a new reference
      // back to, so the viewer hides both affordances rather than offering an
      // action that would silently do nothing.
    };
    openFileViewerFor(descriptor);
  }, [hash, fileName, mimeType, size, hasSize, category, openFileViewerFor]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // An inline atom with a click handler and no keyboard path is unreachable
      // for anyone not using a mouse.
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    },
    [open],
  );

  const handleDownload = useCallback(
    async (e: React.MouseEvent) => {
      // Don't also open the viewer — download is the shortcut past it.
      e.stopPropagation();
      if (!hash || busy) return;
      setBusy(true);
      try {
        const blob = await blobStorage.loadBlob(hash);
        if (blob) downloadBlob(blob, fileName || 'attachment');
      } catch (err) {
        console.error('FileRefChip: download failed', err);
      } finally {
        setBusy(false);
      }
    },
    [hash, fileName, busy],
  );

  const displayName = fileName || 'Attachment';
  const shownName = truncateFileNameForDisplay(displayName, MAX_NAME_CHARS);
  const sizeLabel = hasSize ? formatFileSize(size) : '';

  const label = missing
    ? `${displayName} — file unavailable`
    : `Open ${displayName}${sizeLabel ? `, ${sizeLabel}` : ''}`;

  return (
    <NodeViewWrapper
      as="span"
      className={`file-ref${missing ? ' file-ref-missing' : ''}${busy ? ' file-ref-busy' : ''}`}
      data-file-ref=""
      contentEditable={false}
      role="button"
      tabIndex={0}
      aria-label={label}
      // The full name, since the visible one may be truncated.
      title={missing ? `${displayName} (unavailable)` : displayName}
      onClick={open}
      onKeyDown={handleKeyDown}
    >
      <Icon icon={FileIcon} size={14} className="file-ref-icon" />
      <span className="file-ref-name">{shownName}</span>
      {sizeLabel && <span className="file-ref-size">{sizeLabel}</span>}
      {!missing && (
        <button
          type="button"
          className="file-ref-download"
          onClick={handleDownload}
          disabled={busy}
          // The chip already carries the file's name for screen readers.
          aria-label={`Download ${displayName}`}
          title="Download"
          tabIndex={-1}
        >
          <Icon icon={Download} size={12} />
        </button>
      )}
    </NodeViewWrapper>
  );
}
