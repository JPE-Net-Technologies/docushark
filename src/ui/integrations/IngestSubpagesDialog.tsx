/**
 * IngestSubpagesDialog (JP-475) — "Ingest subpages…" on a mirror page's tab.
 *
 * Opens with a FRESH listing (listSubpages refreshes the parent — ingestion
 * always works against current source state), lets the user pick which
 * children to mirror, then runs the sequential batch with progress + cancel.
 * Modal chrome mirrors <MirrorResourcePicker/> (overlay + card + Escape),
 * except mid-run: the Cancel button is the only mid-run exit, so a stray
 * Escape can't silently abandon a half-ingested family.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Icon } from '../icons';

import {
  ingestSubpages,
  listSubpages,
  type IngestOutcome,
  type SubpageListing,
} from '../../services/mirrorPageService';
import { providerLabel, useIntegrationHubStore } from '../../store/integrationHubStore';
import { useRichTextPagesStore } from '../../store/richTextPagesStore';
import { ProviderIcon } from './ProviderIcon';
import './IngestSubpagesDialog.css';

interface IngestSubpagesDialogProps {
  pageId: string;
  onClose: () => void;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'list'; listing: SubpageListing }
  | { kind: 'running'; done: number; total: number; currentTitle: string }
  | { kind: 'done'; outcome: IngestOutcome };

export function IngestSubpagesDialog({ pageId, onClose }: IngestSubpagesDialogProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [recurse, setRecurse] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const hub = useIntegrationHubStore((s) => s.hub);
  const parentName = useRichTextPagesStore((s) => s.pages[pageId]?.name ?? 'Untitled');

  const running = phase.kind === 'running';

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !running) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [onClose, running]);

  // Abandoning the dialog mid-run (unmount) cancels the run.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    let cancelled = false;
    listSubpages(pageId)
      .then((listing) => {
        if (cancelled) return;
        setChecked(new Set(listing.candidates.filter((c) => c.status === 'new').map((c) => c.externalId)));
        setPhase({ kind: 'list', listing });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setPhase({ kind: 'error', message: e instanceof Error ? e.message : 'Could not load subpages.' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  const toggle = useCallback((externalId: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(externalId)) next.delete(externalId);
      else next.add(externalId);
      return next;
    });
  }, []);

  const start = useCallback(
    (listing: SubpageListing) => {
      const selection = listing.candidates
        .filter((c) => c.status === 'new' && checked.has(c.externalId))
        .map(({ externalId, title }) => ({ externalId, title }));
      if (selection.length === 0) return;
      const ac = new AbortController();
      abortRef.current = ac;
      setPhase({ kind: 'running', done: 0, total: selection.length, currentTitle: '' });
      void ingestSubpages(pageId, selection, {
        recurse,
        signal: ac.signal,
        onProgress: (done, total, currentTitle) => setPhase({ kind: 'running', done, total, currentTitle }),
      })
        .then((outcome) => setPhase({ kind: 'done', outcome }))
        .catch((e: unknown) => {
          setPhase({ kind: 'error', message: e instanceof Error ? e.message : 'Ingest failed.' });
        });
    },
    [pageId, checked, recurse],
  );

  const label = phase.kind === 'list' ? providerLabel(hub, phase.listing.provider) : '';
  const newCount = phase.kind === 'list' ? phase.listing.candidates.filter((c) => c.status === 'new').length : 0;
  const selectedCount =
    phase.kind === 'list'
      ? phase.listing.candidates.filter((c) => c.status === 'new' && checked.has(c.externalId)).length
      : 0;

  return (
    <div
      className="ingest-subpages-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}
    >
      <div className="ingest-subpages" role="dialog" aria-modal="true" aria-label={`Ingest subpages of ${parentName}`}>
        <div className="ingest-subpages-head">
          <h2>Ingest subpages of “{parentName}”</h2>
          {!running && (
            <button type="button" className="ingest-subpages-close" onClick={onClose} aria-label="Close">
              <Icon icon={X} size={16} />
            </button>
          )}
        </div>

        {phase.kind === 'loading' && <p className="ingest-subpages-hint">Checking the source for subpages…</p>}
        {phase.kind === 'error' && <p className="ingest-subpages-error">{phase.message}</p>}

        {phase.kind === 'list' && (
          <>
            {phase.listing.candidates.length === 0 ? (
              <p className="ingest-subpages-hint">
                No subpages found on the source page. A subpage nested deep inside other content may not be visible
                to the fetch.
              </p>
            ) : (
              <div className="ingest-subpages-list">
                {phase.listing.candidates.map((c) => (
                  <label key={c.externalId} className="ingest-subpages-row" data-present={c.status === 'present' || undefined}>
                    <input
                      type="checkbox"
                      checked={c.status === 'present' || checked.has(c.externalId)}
                      disabled={c.status === 'present'}
                      onChange={() => toggle(c.externalId)}
                    />
                    <ProviderIcon provider={phase.listing.provider} size={13} />
                    <span className="ingest-subpages-row-title">{c.title}</span>
                    {c.status === 'present' && <span className="ingest-subpages-badge">In document</span>}
                  </label>
                ))}
              </div>
            )}

            {phase.listing.unseen.length > 0 && (
              <p className="ingest-subpages-hint">
                Not seen in the latest fetch (possibly nested deeper, possibly removed at the source):{' '}
                {phase.listing.unseen.map((u) => u.name).join(', ')}. Nothing is deleted automatically.
              </p>
            )}

            <label className="ingest-subpages-recurse">
              <input type="checkbox" checked={recurse} onChange={(e) => setRecurse(e.target.checked)} />
              Include nested subpages (depth-limited)
            </label>

            <div className="ingest-subpages-foot">
              <span className="ingest-subpages-hint">
                {newCount === 0 ? 'Everything is already mirrored.' : `${selectedCount} of ${newCount} new subpage(s) selected`}
              </span>
              <button
                type="button"
                className="ingest-subpages-primary"
                disabled={selectedCount === 0}
                onClick={() => start(phase.listing)}
              >
                Ingest from {label}
              </button>
            </div>
          </>
        )}

        {phase.kind === 'running' && (
          <>
            <p className="ingest-subpages-hint">
              Ingesting {phase.done + 1} of {phase.total}
              {phase.currentTitle ? ` — “${phase.currentTitle}”` : ''}…
            </p>
            <div className="ingest-subpages-progress">
              <div
                className="ingest-subpages-progress-fill"
                style={{ width: `${phase.total > 0 ? Math.round((phase.done / phase.total) * 100) : 0}%` }}
              />
            </div>
            <div className="ingest-subpages-foot">
              <span />
              <button type="button" onClick={() => abortRef.current?.abort()}>
                Cancel
              </button>
            </div>
          </>
        )}

        {phase.kind === 'done' && (
          <>
            <p className="ingest-subpages-hint">
              Added {phase.outcome.added} page(s)
              {phase.outcome.skipped > 0 ? `, skipped ${phase.outcome.skipped} already present` : ''}
              {phase.outcome.truncated > 0 ? `, ${phase.outcome.truncated} left out by the per-run limit` : ''}
              {phase.outcome.aborted ? ' — run cancelled early' : ''}.
            </p>
            {phase.outcome.failed.length > 0 && (
              <p className="ingest-subpages-error">
                Failed: {phase.outcome.failed.map((f) => f.title).join(', ')}. Re-run to retry.
              </p>
            )}
            {phase.outcome.warnings.length > 0 && (
              <p className="ingest-subpages-hint">
                {phase.outcome.warnings.reduce((n, w) => n + (w.count ?? 1), 0)} element(s) could not be mirrored
                faithfully.
              </p>
            )}
            <div className="ingest-subpages-foot">
              <span />
              <button type="button" className="ingest-subpages-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
