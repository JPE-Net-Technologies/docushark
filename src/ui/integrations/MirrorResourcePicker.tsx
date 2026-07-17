/**
 * MirrorResourcePicker (JP-415) — the resource browser behind "New page from
 * <provider>". Search-as-you-type over the control plane's normalized
 * resource search (empty query = the provider's recent ordering), pick a
 * result → a read-only mirror page is added to the open document.
 *
 * Provider-agnostic: everything rendered here comes from the normalized
 * `ExternalResource` shape; the provider only contributes its label and the
 * result rows. Modal chrome mirrors <CloudSignInModal/> (overlay + card +
 * Escape/backdrop dismissal) — search input focus is the entry state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Search, X } from 'lucide-react';
import { Icon } from '../icons';

import { webClient, WebClientError, type ExternalResource, type IntegrationProvider } from '../../api/webClient';
import { addMirrorPage } from '../../services/mirrorPageService';
import { useNotificationStore } from '../../store/notificationStore';
import { ProviderIcon } from './ProviderIcon';
import './MirrorResourcePicker.css';

const SEARCH_DEBOUNCE_MS = 300;

interface MirrorResourcePickerProps {
  provider: IntegrationProvider;
  onClose: () => void;
}

/** Compact "modified" label for a result row (e.g. "2d ago"). */
function modifiedLabel(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.floor((now - t) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

function searchErrorMessage(e: unknown, providerLabel: string): string {
  if (e instanceof WebClientError) {
    if (e.status === 402) return 'Integrations are available on paid plans — upgrade your workspace to use them.';
    if (e.status === 409) return `${providerLabel} is not connected for this workspace — connect it from your account page.`;
    if (e.status === 0) return 'You are offline or signed out — sign in to the cloud and try again.';
  }
  return `Search failed — ${providerLabel} may be unreachable. Try again.`;
}

export function MirrorResourcePicker({ provider, onClose }: MirrorResourcePickerProps) {
  const [query, setQuery] = useState('');
  const [resources, setResources] = useState<ExternalResource[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<'searching' | 'ready' | 'error'>('searching');
  const [errorText, setErrorText] = useState('');
  const [addingId, setAddingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [onClose]);

  const runSearch = useCallback(
    async (q: string, cursor?: string) => {
      const seq = ++searchSeq.current;
      if (!cursor) setPhase('searching');
      try {
        const page = await webClient.searchIntegrationResources(provider.id, q, cursor ? { cursor } : {});
        if (seq !== searchSeq.current) return; // superseded by newer keystrokes
        setResources((prev) => (cursor ? [...prev, ...page.resources] : page.resources));
        setNextCursor(page.nextCursor);
        setPhase('ready');
      } catch (e) {
        if (seq !== searchSeq.current) return;
        setErrorText(searchErrorMessage(e, provider.label));
        setPhase('error');
      }
    },
    [provider.id, provider.label],
  );

  // Debounced search-as-you-type; the mount runs an empty query ("recent").
  useEffect(() => {
    const timer = setTimeout(() => void runSearch(query), query === '' ? 0 : SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  const handlePick = useCallback(
    async (resource: ExternalResource) => {
      if (addingId) return;
      setAddingId(resource.externalId);
      const notifications = useNotificationStore.getState();
      try {
        const { warnings } = await addMirrorPage(provider.id, resource.externalId);
        const dropped = warnings.reduce((n, w) => n + (w.count ?? 1), 0);
        notifications.success(
          dropped > 0
            ? `Added "${resource.title}" from ${provider.label} — ${dropped} element(s) could not be mirrored`
            : `Added "${resource.title}" from ${provider.label}`,
        );
        onClose();
      } catch (e) {
        setAddingId(null);
        notifications.error(e instanceof Error ? e.message : `Could not add the page from ${provider.label}.`);
      }
    },
    [addingId, provider.id, provider.label, onClose],
  );

  return (
    <div className="mirror-picker-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mirror-picker" role="dialog" aria-modal="true" aria-label={`New page from ${provider.label}`}>
        <div className="mirror-picker-head">
          <h2>
            <ProviderIcon provider={provider.id} size={16} />
            New page from {provider.label}
          </h2>
          <button type="button" className="mirror-picker-close" onClick={onClose} aria-label="Close">
            <Icon icon={X} size={16} />
          </button>
        </div>

        <div className="mirror-picker-search">
          <Icon icon={Search} size={14} className="mirror-picker-search-icon" />
          <input
            ref={inputRef}
            type="text"
            placeholder={`Search ${provider.label} pages…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={`Search ${provider.label} pages`}
          />
        </div>

        <div className="mirror-picker-results">
          {phase === 'searching' && <p className="mirror-picker-hint">Searching…</p>}
          {phase === 'error' && <p className="mirror-picker-error">{errorText}</p>}
          {phase === 'ready' && resources.length === 0 && (
            <p className="mirror-picker-hint">
              {query ? 'No matches — try a different search.' : 'No pages shared with the DocuShark connection yet.'}
            </p>
          )}
          {phase !== 'searching' &&
            resources.map((r) => (
              <button
                key={r.externalId}
                type="button"
                className="mirror-picker-row"
                onClick={() => void handlePick(r)}
                disabled={addingId !== null}
                data-busy={addingId === r.externalId || undefined}
              >
                <span className="mirror-picker-row-icon" aria-hidden="true">
                  {r.iconEmoji ?? <Icon icon={FileText} size={13} />}
                </span>
                <span className="mirror-picker-row-title">{r.title}</span>
                <span className="mirror-picker-row-modified">
                  {addingId === r.externalId ? 'Adding…' : modifiedLabel(r.modifiedAt)}
                </span>
              </button>
            ))}
          {phase === 'ready' && nextCursor && (
            <button
              type="button"
              className="mirror-picker-more"
              onClick={() => void runSearch(query, nextCursor)}
              disabled={addingId !== null}
            >
              Load more
            </button>
          )}
        </div>

        <p className="mirror-picker-foot">Mirrored pages are read-only and refresh from the source on demand.</p>
      </div>
    </div>
  );
}
