/**
 * DocumentBackupsDrawer (JP-183)
 *
 * The editor's "backups" surface for a cloud document — the functional
 * successor to canvas undo/redo, which is disabled in collab (JP-178). Lists the
 * relay's recovery points for a document (captured by the poison guard, JP-180)
 * and offers two actions per point:
 *
 *  - **Restore** — POST the recovery point back to the relay. The relay writes
 *    it as a NEW document and tombstones the source id; connected editors are
 *    returned to the browser with their pre-restore copy stranded to Trash
 *    (JP-375). Non-trivial, so it confirms first.
 *  - **Save to local** — fetch the point's content (non-destructive) and adopt
 *    it as a fresh LOCAL document, so you keep a copy without touching the cloud
 *    doc. This is the "download to local" escape hatch.
 *
 * All relay access goes through the authed REST provider (`getDocProvider`),
 * the same path as document CRUD.
 */

import { useCallback, useEffect, useState } from 'react';
import { getDocProvider } from '../store/relayDocumentStore';
import { useNotificationStore } from '../store/notificationStore';
import { saveDocumentToStorage } from '../store/persistenceStore';
import { useDocumentRegistry } from '../store/documentRegistry';
import { getDocumentMetadata } from '../types/Document';
import { confirmDialog } from './confirm/confirmStore';
import type { RelayRecoveryPoint } from '../api/relayClient';
import './DocumentBackupsDrawer.css';

interface DocumentBackupsDrawerProps {
  /** The cloud document whose backups to show. */
  docId: string;
  /** Display name (for the header + restored-copy naming). */
  docName: string;
  /** Close the drawer. */
  onClose: () => void;
  /** Called after a successful restore with the new document id. */
  onRestored?: (newDocId: string) => void;
}

function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentBackupsDrawer({
  docId,
  docName,
  onClose,
  onRestored,
}: DocumentBackupsDrawerProps) {
  const [points, setPoints] = useState<RelayRecoveryPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    const provider = getDocProvider();
    if (!provider?.listRecoveryPoints) {
      setError('Backups are only available for cloud documents.');
      setPoints([]);
      return;
    }
    setError(null);
    provider
      .listRecoveryPoints(docId)
      .then((p) => setPoints(p))
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Failed to load backups.');
        setPoints([]);
      });
  }, [docId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRestore = useCallback(
    async (point: RelayRecoveryPoint) => {
      const provider = getDocProvider();
      if (!provider?.restoreRecoveryPoint) return;
      const ok = await confirmDialog({
        title: 'Restore this version?',
        message: `Restore "${docName}" to its state from ${formatTimestamp(point.createdAt)}.`,
        details:
          'This restores as a new document. Anyone currently in the document is returned to the browser, and their current copy is saved to their Trash.',
        confirmLabel: 'Restore',
      });
      if (!ok) return;
      setBusyId(point.id);
      try {
        const { newDocId } = await provider.restoreRecoveryPoint(docId, point.id);
        useNotificationStore.getState().success('Document restored as a new copy.');
        onRestored?.(newDocId);
        onClose();
      } catch (e) {
        useNotificationStore
          .getState()
          .error(`Restore failed: ${e instanceof Error ? e.message : 'unknown error'}`);
      } finally {
        setBusyId(null);
      }
    },
    [docId, docName, onClose, onRestored],
  );

  const handleSaveLocal = useCallback(
    async (point: RelayRecoveryPoint) => {
      const provider = getDocProvider();
      if (!provider?.getRecoveryPointContent) return;
      setBusyId(point.id);
      try {
        const content = await provider.getRecoveryPointContent(docId, point.id);
        const copy = {
          ...content,
          id: crypto.randomUUID(),
          name: `${docName} (Restored ${new Date(point.createdAt).toLocaleDateString()})`,
          isRelayDocument: false,
        };
        delete copy.ownerId;
        delete copy.ownerName;
        delete copy.sharedWith;
        delete copy.collectionId;
        delete copy.serverVersion;
        saveDocumentToStorage(copy);
        useDocumentRegistry.getState().registerLocal(getDocumentMetadata(copy));
        useNotificationStore.getState().success('Saved a local copy of this version.');
      } catch (e) {
        useNotificationStore
          .getState()
          .error(`Couldn't save a local copy: ${e instanceof Error ? e.message : 'unknown error'}`);
      } finally {
        setBusyId(null);
      }
    },
    [docId, docName],
  );

  return (
    <div className="backups-drawer__overlay" onClick={onClose}>
      <div
        className="backups-drawer"
        role="dialog"
        aria-label={`Backups for ${docName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="backups-drawer__header">
          <h3>Backups — {docName}</h3>
          <button className="backups-drawer__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="backups-drawer__content">
          <p className="backups-drawer__hint">
            Saved versions of this document, newest first. Restore replaces the live
            document (as a new copy); Save to local keeps a copy on this device.
          </p>
          {error && <p className="backups-drawer__error">{error}</p>}
          {points === null ? (
            <p className="backups-drawer__empty">Loading…</p>
          ) : points.length === 0 ? (
            <p className="backups-drawer__empty">
              No backups yet. They&rsquo;re captured automatically when a document is at risk
              of losing content.
            </p>
          ) : (
            <ul className="backups-drawer__list">
              {points.map((point) => (
                <li key={point.id} className="backups-drawer__row">
                  <div className="backups-drawer__meta">
                    <span className="backups-drawer__time">{formatTimestamp(point.createdAt)}</span>
                    <span className="backups-drawer__sub">
                      v{point.serverVersion} · {formatSize(point.sizeBytes)}
                    </span>
                  </div>
                  <div className="backups-drawer__actions">
                    <button
                      className="backups-drawer__btn"
                      disabled={busyId !== null}
                      onClick={() => handleSaveLocal(point)}
                    >
                      Save to local
                    </button>
                    <button
                      className="backups-drawer__btn backups-drawer__btn--primary"
                      disabled={busyId !== null}
                      onClick={() => handleRestore(point)}
                    >
                      Restore
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
