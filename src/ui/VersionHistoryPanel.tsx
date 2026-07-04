/**
 * VersionHistoryPanel (JP-185, grown out of the JP-183 backups drawer)
 *
 * The version-history surface for a cloud document — the collab-native answer
 * to "undo across sessions". Lists the relay's recovery points (captured
 * automatically: periodically while the document is edited, at session end,
 * and by the JP-180 poison guard), newest first and grouped by day. Selecting
 * a version fetches its content and shows a lightweight summary (pages, shape
 * counts, word counts, delta vs the current document). Two actions per
 * version:
 *
 *  - **Restore** — POST the recovery point back to the relay. The relay writes
 *    it as a NEW document and tombstones the source id (JP-375); the caller
 *    navigates via `onRestored`. Non-trivial, so it confirms first.
 *  - **Save to local** — fetch the version's content (non-destructive) and
 *    adopt it as a fresh LOCAL document, so you keep a copy without touching
 *    the cloud doc.
 *
 * All relay access goes through the authed REST provider (`getDocProvider`),
 * the same path as document CRUD.
 */

import { useCallback, useEffect, useState } from 'react';
import { getDocProvider, useRelayDocumentStore } from '../store/relayDocumentStore';
import { useNotificationStore } from '../store/notificationStore';
import { saveDocumentToStorage } from '../store/persistenceStore';
import { useDocumentRegistry } from '../store/documentRegistry';
import { getDocumentMetadata } from '../types/Document';
import type { DiagramDocument } from '../types/Document';
import { migrateDocument } from '../migrations/documentMigrations';
import { confirmDialog } from './confirm/confirmStore';
import {
  summarizeDocument,
  diffVersionSummaries,
  groupPointsByDay,
  type VersionSummary,
} from '../utils/versionSummary';
import type { RelayRecoveryPoint } from '../api/relayClient';
import './VersionHistoryPanel.css';

interface VersionHistoryPanelProps {
  /** The cloud document whose versions to show. */
  docId: string;
  /** Display name (for the header + restored-copy naming). */
  docName: string;
  /** Close the panel. */
  onClose: () => void;
  /** Called after a successful restore with the new document id. */
  onRestored?: (newDocId: string) => void;
}

/**
 * Build the local-document copy of a version's content (JP-428): runs the
 * JP-347 migration funnel (version content skips the normal open path), mints
 * a fresh id, and strips relay-ownership fields. Pure — exported for tests.
 */
export function buildLocalCopyFromVersion(
  content: DiagramDocument,
  docName: string,
  createdAt: number,
): DiagramDocument {
  const copy = {
    ...migrateDocument(content),
    id: crypto.randomUUID(),
    name: `${docName} (Restored ${formatTimestamp(createdAt)})`,
    isRelayDocument: false,
  };
  delete copy.ownerId;
  delete copy.ownerName;
  delete copy.sharedWith;
  delete copy.collectionId;
  delete copy.serverVersion;
  return copy;
}

function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function formatTimeOfDay(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return String(ms);
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render a signed count ("+3", "−2") or null when unchanged. */
function signed(n: number): string | null {
  if (n === 0) return null;
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}

export function VersionHistoryPanel({
  docId,
  docName,
  onClose,
  onRestored,
}: VersionHistoryPanelProps) {
  const [points, setPoints] = useState<RelayRecoveryPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Current document's summary — the delta baseline. Fetched once per open. */
  const [currentSummary, setCurrentSummary] = useState<VersionSummary | null>(null);
  /** Per-version summaries, cached across selections. */
  const [summaries, setSummaries] = useState<Record<string, VersionSummary>>({});
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const load = useCallback(() => {
    const provider = getDocProvider();
    if (!provider?.listRecoveryPoints) {
      setError('Version history is only available for cloud documents.');
      setPoints([]);
      return;
    }
    setError(null);
    // Capture-on-open (JP-428): ask the relay for a fresh point first so the
    // timeline leads with current state instead of the last periodic tick.
    // Best-effort — an old relay (404) or transient failure still lists.
    const fresh = provider.captureRecoveryPoint
      ? provider.captureRecoveryPoint(docId).catch(() => undefined)
      : Promise.resolve(undefined);
    fresh
      .then(() => provider.listRecoveryPoints!(docId))
      .then((p) => setPoints(p))
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Failed to load version history.');
        setPoints([]);
      });
  }, [docId]);

  useEffect(() => {
    load();
  }, [load]);

  // The current document's summary is the "vs current" baseline for every
  // version, so fetch it once when the panel opens.
  useEffect(() => {
    const provider = getDocProvider();
    if (!provider) return;
    let cancelled = false;
    provider
      .getDocument(docId)
      .then((result) => {
        if (cancelled) return;
        const doc: DiagramDocument = 'document' in result ? result.document : result;
        setCurrentSummary(summarizeDocument(doc));
      })
      .catch(() => {
        // Delta is a nicety — the list still renders without it.
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const handleSelect = useCallback(
    (point: RelayRecoveryPoint) => {
      setSummaryError(null);
      setSelectedId((prev) => (prev === point.id ? null : point.id));
      if (summaries[point.id]) return;
      const provider = getDocProvider();
      if (!provider?.getRecoveryPointContent) return;
      provider
        .getRecoveryPointContent(docId, point.id)
        .then((content) => {
          setSummaries((prev) => ({ ...prev, [point.id]: summarizeDocument(content) }));
        })
        .catch((e) => {
          setSummaryError(
            e instanceof Error ? e.message : "Couldn't load this version's contents.",
          );
        });
    },
    [docId, summaries],
  );

  const handleRestore = useCallback(
    async (point: RelayRecoveryPoint) => {
      const provider = getDocProvider();
      if (!provider?.restoreRecoveryPoint) return;
      const ok = await confirmDialog({
        title: 'Restore this version?',
        message: `Restore "${docName}" to its state from ${formatTimestamp(point.createdAt)}.`,
        details:
          'This restores as a new document and retires the current one. Collaborators who have it open keep an offline local copy; everyone else finds their copy in Trash.',
        confirmLabel: 'Restore',
      });
      if (!ok) return;
      setBusyId(point.id);
      try {
        const { newDocId } = await provider.restoreRecoveryPoint(docId, point.id);
        // Refetch the list so the new doc appears immediately — don't rely on the
        // relay's Created broadcast (a REST-only session never receives it, and a
        // list view may not re-subscribe), which left it hidden until a reload.
        await useRelayDocumentStore.getState().fetchDocumentList().catch(() => {});
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
        // Field-test breadcrumb: which point was served and how much prose it
        // carried, so "the copy looks old" reports are correlatable with the
        // relay's recovery-read log line.
        console.info(
          `[version-history] save-to-local doc=${docId} point=${point.id} words=${summarizeDocument(content).totalWords}`,
        );
        const copy = buildLocalCopyFromVersion(content, docName, point.createdAt);
        saveDocumentToStorage(copy);
        useDocumentRegistry.getState().registerLocal(getDocumentMetadata(copy));
        useNotificationStore
          .getState()
          .success(`Saved a local copy of the ${formatTimeOfDay(point.createdAt)} version.`);
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

  const renderSummary = (point: RelayRecoveryPoint) => {
    const summary = summaries[point.id];
    if (!summary) {
      return (
        <p className="version-history__summary-note">
          {summaryError ?? 'Loading version contents…'}
        </p>
      );
    }
    const delta = currentSummary ? diffVersionSummaries(currentSummary, summary) : null;
    const shapeDelta = delta ? signed(delta.shapeDelta) : null;
    const wordDelta = delta ? signed(delta.wordDelta) : null;
    const unchanged =
      delta &&
      !shapeDelta &&
      !wordDelta &&
      delta.pagesOnlyInVersion.length === 0 &&
      delta.pagesOnlyInCurrent.length === 0;
    return (
      <div className="version-history__summary">
        <ul className="version-history__summary-pages">
          {summary.canvasPages.map((p) => (
            <li key={`c-${p.id}`}>
              <span className="version-history__page-name">{p.name}</span>
              <span className="version-history__page-count">
                {p.shapeCount} {p.shapeCount === 1 ? 'shape' : 'shapes'}
              </span>
            </li>
          ))}
          {summary.prosePages.map((p) => (
            <li key={`p-${p.id}`}>
              <span className="version-history__page-name">{p.name}</span>
              <span className="version-history__page-count">
                {p.wordCount} {p.wordCount === 1 ? 'word' : 'words'}
              </span>
            </li>
          ))}
        </ul>
        {delta && (
          <p className="version-history__delta">
            {delta.pagesOnlyInVersion.length > 0 && (
              <span>Restores {delta.pagesOnlyInVersion.join(', ')}. </span>
            )}
            {delta.pagesOnlyInCurrent.length > 0 && (
              <span>Removes {delta.pagesOnlyInCurrent.join(', ')}. </span>
            )}
            {(shapeDelta || wordDelta) && (
              <span>
                {[
                  shapeDelta ? `${shapeDelta} shapes` : null,
                  wordDelta ? `${wordDelta} words` : null,
                ]
                  .filter(Boolean)
                  .join(', ')}{' '}
                vs current.
              </span>
            )}
            {unchanged && <span>Same page and shape counts as current.</span>}
          </p>
        )}
        <div className="version-history__actions">
          <button
            className="version-history__btn"
            disabled={busyId !== null}
            onClick={() => handleSaveLocal(point)}
          >
            Save to local
          </button>
          <button
            className="version-history__btn version-history__btn--primary"
            disabled={busyId !== null}
            onClick={() => handleRestore(point)}
          >
            Restore
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="version-history__overlay" onClick={onClose}>
      <div
        className="version-history"
        role="dialog"
        aria-label={`Version history for ${docName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="version-history__header">
          <h3>Version history — {docName}</h3>
          <button className="version-history__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="version-history__content">
          <div className="version-history__current">
            <span className="version-history__time">Current version</span>
            <span className="version-history__sub">
              {currentSummary
                ? `${currentSummary.totalShapes} shapes · ${currentSummary.totalWords} words`
                : docName}
            </span>
          </div>
          {error && <p className="version-history__error">{error}</p>}
          {points === null ? (
            <p className="version-history__empty">Loading…</p>
          ) : points.length === 0 ? (
            <p className="version-history__empty">
              No versions yet — versions are captured automatically as you edit.
            </p>
          ) : (
            groupPointsByDay(points).map((group) => (
              <section key={group.label} className="version-history__group">
                <h4 className="version-history__day">{group.label}</h4>
                <ul className="version-history__list">
                  {group.points.map((point) => {
                    const selected = selectedId === point.id;
                    return (
                      <li
                        key={point.id}
                        className={
                          selected
                            ? 'version-history__row version-history__row--selected'
                            : 'version-history__row'
                        }
                      >
                        <button
                          className="version-history__row-main"
                          aria-expanded={selected}
                          onClick={() => handleSelect(point)}
                        >
                          <span className="version-history__time">
                            {formatTimeOfDay(point.createdAt)}
                            {point.id === points[0]?.id && (
                              <span className="version-history__latest">Latest</span>
                            )}
                          </span>
                          <span className="version-history__sub">
                            v{point.serverVersion} · {formatSize(point.sizeBytes)}
                          </span>
                        </button>
                        {selected && renderSummary(point)}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
