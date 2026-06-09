/**
 * TrashView — the Documents "Trash" bin (JP-293).
 *
 * Lists soft-deleted documents the user can recover or purge. Two kinds today
 * (a future relay-soft-delete kind, JP-294, slots in via `trashStore`):
 *  - **Local**    — a personal document the user deleted.
 *  - **Stranded** — a relay document hard-deleted on the relay; we kept the
 *    last local copy here rather than wiping it.
 *
 * Per item: Restore (both kinds come back as a *local* document) and Delete
 * permanently. A header "Empty Trash" (the fire button) purges everything and
 * reclaims the blob bytes only the Trash was keeping alive.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Flame, RotateCcw, Trash2, Cloud, HardDrive } from 'lucide-react';
import { useTrashStore, getTrashReclaimableBytes } from '../../store/trashStore';
import type { TrashItem } from '../../storage/TrashStorage';
import { formatFileSize } from '../../utils/imageUtils';

export interface TrashViewProps {
  /** Back to the documents list. */
  onBack: () => void;
}

/** "in 3 days" / "in 5 hours" / "soon" for an expiry timestamp. */
function formatExpiry(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'any moment now';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `in ${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  return 'soon';
}

function kindLabel(item: TrashItem): { label: string; Icon: typeof Cloud } {
  return item.kind === 'stranded'
    ? { label: 'Stranded', Icon: Cloud }
    : { label: 'Local', Icon: HardDrive };
}

export function TrashView({ onBack }: TrashViewProps) {
  const items = useTrashStore((s) => s.items);
  const refresh = useTrashStore((s) => s.refresh);
  const restore = useTrashStore((s) => s.restore);
  const purge = useTrashStore((s) => s.purge);
  const emptyAll = useTrashStore((s) => s.emptyAll);

  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [reclaimable, setReclaimable] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  // Reload from storage on open (other surfaces may have changed it).
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Recompute reclaimable bytes whenever the list changes.
  useEffect(() => {
    let cancelled = false;
    if (items.length === 0) {
      setReclaimable(0);
      return;
    }
    void getTrashReclaimableBytes().then((b) => {
      if (!cancelled) setReclaimable(b);
    });
    return () => {
      cancelled = true;
    };
  }, [items]);

  const sorted = useMemo(() => [...items].sort((a, b) => b.deletedAt - a.deletedAt), [items]);

  const onEmpty = async () => {
    setBusy(true);
    try {
      await emptyAll();
    } finally {
      setBusy(false);
      setConfirmEmpty(false);
    }
  };

  return (
    <>
      <header className="dh-top">
        <button className="dh-back" onClick={onBack} title="Back to documents">
          <ChevronLeft size={18} aria-hidden="true" />
          <span>Documents</span>
        </button>
        <div className="dh-crumb">
          <strong>Trash</strong>
          <span className="trash-sub">{items.length} item{items.length === 1 ? '' : 's'}</span>
        </div>
        <div className="dh-top-actions">
          {!confirmEmpty ? (
            <button
              className="trash-empty-btn"
              onClick={() => setConfirmEmpty(true)}
              disabled={items.length === 0 || busy}
              title="Permanently delete everything in the Trash"
            >
              <Flame size={16} aria-hidden="true" />
              <span>Empty Trash</span>
              {reclaimable != null && reclaimable > 0 && (
                <span className="trash-empty-bytes">frees {formatFileSize(reclaimable)}</span>
              )}
            </button>
          ) : (
            <div className="trash-confirm">
              <span>Delete all {items.length} permanently?</span>
              <button className="trash-confirm-yes" onClick={onEmpty} disabled={busy}>
                Empty
              </button>
              <button className="trash-confirm-no" onClick={() => setConfirmEmpty(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="dh-content">
        {sorted.length === 0 ? (
          <div className="trash-empty-state">
            <Trash2 size={32} aria-hidden="true" />
            <p>Trash is empty.</p>
            <span>Deleted documents land here and are removed automatically after a while.</span>
          </div>
        ) : (
          <ul className="trash-list">
            {sorted.map((item) => {
              const { label, Icon } = kindLabel(item);
              return (
                <li key={item.id} className="trash-row">
                  <span className="trash-kind" title={label}>
                    <Icon size={16} aria-hidden="true" />
                  </span>
                  <span className="trash-meta">
                    <span className="trash-name">{item.name}</span>
                    <span className="trash-detail">
                      <span className={`trash-tag trash-tag--${item.kind ?? 'local'}`}>{label}</span>
                      <span className="trash-expiry">Removed {formatExpiry(item.expiresAt)}</span>
                    </span>
                  </span>
                  <span className="trash-actions">
                    <button
                      className="trash-action"
                      onClick={() => void restore(item.id)}
                      title={
                        item.kind === 'stranded'
                          ? 'Keep as a local document (the relay copy is gone)'
                          : 'Restore this document'
                      }
                    >
                      <RotateCcw size={15} aria-hidden="true" />
                      <span>{item.kind === 'stranded' ? 'Keep local' : 'Restore'}</span>
                    </button>
                    <button
                      className="trash-action trash-action--danger"
                      onClick={() => void purge(item.id)}
                      title="Delete permanently"
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

export default TrashView;
