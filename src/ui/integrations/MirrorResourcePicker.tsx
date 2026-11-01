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
 *
 * The search box drives the results as a combobox (DSK-194): Up and Down move
 * through them while focus stays in the box, and Enter picks, as in the command
 * palette. Each row says where the resource lives and what kind it is, when the
 * control plane says, so two pages with similar titles can be told apart.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ExternalLink, FileText, Search, X } from 'lucide-react';
import { Icon } from '../icons';

import { webClient, WebClientError, type ExternalResource, type IntegrationProvider } from '../../api/webClient';
import { addMirrorPage, type MirrorAddStage, type MirrorPageResult } from '../../services/mirrorPageService';
import { openAccountIntegrations } from '../../services/integrationActions';
import { useNotificationStore } from '../../store/notificationStore';
import { ProviderIcon } from './ProviderIcon';
import './MirrorResourcePicker.css';

const SEARCH_DEBOUNCE_MS = 300;

interface MirrorResourcePickerProps {
  provider: IntegrationProvider;
  onClose: () => void;
  /**
   * What picking a resource does. By default it becomes a mirror page of the
   * open document; the document browser imports it as a new document instead
   * (DSK-194).
   */
  onPick?: (resource: ExternalResource, onStage: (stage: MirrorAddStage) => void) => Promise<MirrorPageResult>;
  /** The dialog's title; "New page from <provider>" by default. */
  title?: string;
}

/**
 * "Modified" label for a result row, always relative ("5m ago", "3mo ago").
 * Rows older than a month used to switch to a locale date, so one list mixed
 * two formats (DSK-194); the exact time is on the label's tooltip.
 */
export function modifiedLabel(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.floor((now - t) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function searchErrorMessage(e: unknown, providerLabel: string): string {
  if (e instanceof WebClientError) {
    if (e.status === 402) return 'Integrations are available on paid plans — upgrade your workspace to use them.';
    if (e.status === 409) return `${providerLabel} is not connected for this workspace — connect it from your account page.`;
    if (e.status === 0) return 'You are offline or signed out — sign in to the cloud and try again.';
  }
  return `Search failed — ${providerLabel} may be unreachable. Try again.`;
}

/** The page being added, and how far it has got. */
interface Adding {
  externalId: string;
  title: string;
  stage: MirrorAddStage;
}

/** The progress line for the picker's foot, read out as it changes. */
function stageText({ title, stage }: Adding, providerLabel: string): string {
  return stage === 'fetching'
    ? `Fetching “${title}” and its images from ${providerLabel}…`
    : `Adding “${title}” to the document…`;
}

export function MirrorResourcePicker({ provider, onClose, onPick, title }: MirrorResourcePickerProps) {
  const heading = title ?? `New page from ${provider.label}`;
  const [query, setQuery] = useState('');
  const [resources, setResources] = useState<ExternalResource[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<'searching' | 'ready' | 'error'>('searching');
  const [errorText, setErrorText] = useState('');
  const [adding, setAdding] = useState<Adding | null>(null);
  // The row Enter would pick; follows the arrow keys and the pointer.
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);
  const baseId = useId();
  const listId = `${baseId}-results`;
  const optionId = (index: number) => `${baseId}-result-${index}`;

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
        // A new search starts at its top result; "Load more" keeps your place.
        if (!cursor) setActive(0);
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

  // Keep the active row in view as the arrow keys move past the visible ones.
  useEffect(() => {
    document.getElementById(`${baseId}-result-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, baseId]);

  const handlePick = useCallback(
    async (resource: ExternalResource) => {
      if (adding) return;
      const title = resource.title;
      setAdding({ externalId: resource.externalId, title, stage: 'fetching' });
      const notifications = useNotificationStore.getState();
      try {
        const onStage = (stage: MirrorAddStage) => setAdding({ externalId: resource.externalId, title, stage });
        const { warnings } = onPick
          ? await onPick(resource, onStage)
          : await addMirrorPage(provider.id, resource.externalId, {}, { onStage });
        const dropped = warnings.reduce((n, w) => n + (w.count ?? 1), 0);
        notifications.success(
          dropped > 0
            ? `Added "${title}" from ${provider.label} — ${dropped} element(s) could not be mirrored`
            : `Added "${title}" from ${provider.label}`,
        );
        onClose();
      } catch (e) {
        setAdding(null);
        notifications.error(e instanceof Error ? e.message : `Could not add the page from ${provider.label}.`);
      }
    },
    [adding, provider.id, provider.label, onClose, onPick],
  );

  const showRows = phase === 'ready' && resources.length > 0;

  const handleSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!showRows || adding) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, resources.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const picked = resources[active];
      if (picked) void handlePick(picked);
    }
  };

  const choosePages = (
    <button
      type="button"
      className="mirror-picker-choose"
      onClick={() => void openAccountIntegrations(provider.id)}
      title={`Share more ${provider.label} pages with DocuShark, on your account page`}
    >
      Choose pages in {provider.label}…
      <Icon icon={ExternalLink} size={12} />
    </button>
  );

  return (
    <div className="mirror-picker-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mirror-picker" role="dialog" aria-modal="true" aria-label={heading}>
        <div className="mirror-picker-head">
          <h2>
            <ProviderIcon provider={provider.id} size={16} />
            {heading}
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
            role="combobox"
            aria-expanded={showRows}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showRows && resources[active] ? optionId(active) : undefined}
            placeholder={`Search ${provider.label} pages…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKey}
            aria-label={`Search ${provider.label} pages`}
          />
        </div>

        <div className="mirror-picker-results">
          {phase === 'searching' && <p className="mirror-picker-hint">Searching…</p>}
          {phase === 'error' && <p className="mirror-picker-error">{errorText}</p>}
          {phase === 'ready' && resources.length === 0 && (
            <div className="mirror-picker-empty">
              <p className="mirror-picker-hint">
                {query
                  ? `No matches. A page has to be shared with DocuShark in ${provider.label} before it can be found here.`
                  : `No ${provider.label} pages are shared with DocuShark yet.`}
              </p>
              {choosePages}
            </div>
          )}
          <div role="listbox" id={listId} aria-label={`${provider.label} pages`}>
            {showRows &&
              resources.map((r, i) => {
                const stage = adding?.externalId === r.externalId ? adding.stage : null;
                return (
                  <div
                    key={r.externalId}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    aria-disabled={adding !== null}
                    className="mirror-picker-row"
                    data-active={i === active || undefined}
                    data-busy={stage ? true : undefined}
                    onClick={() => void handlePick(r)}
                    onMouseMove={() => setActive(i)}
                  >
                    <span className="mirror-picker-row-icon" aria-hidden="true">
                      {r.iconEmoji ?? <Icon icon={FileText} size={13} />}
                    </span>
                    <span className="mirror-picker-row-main">
                      <span className="mirror-picker-row-title">{r.title}</span>
                      {(r.typeLabel || r.parentTitle) && (
                        <span className="mirror-picker-row-context">
                          {r.typeLabel && <span className="mirror-picker-row-type">{r.typeLabel}</span>}
                          {r.parentTitle && <span className="mirror-picker-row-parent">in {r.parentTitle}</span>}
                        </span>
                      )}
                    </span>
                    <span
                      className="mirror-picker-row-modified"
                      {...(r.modifiedAt && !stage ? { title: new Date(r.modifiedAt).toLocaleString() } : {})}
                    >
                      {stage === 'fetching' ? 'Fetching…' : stage === 'adding' ? 'Adding…' : modifiedLabel(r.modifiedAt)}
                    </span>
                  </div>
                );
              })}
          </div>
          {phase === 'ready' && nextCursor && (
            <button
              type="button"
              className="mirror-picker-more"
              onClick={() => void runSearch(query, nextCursor)}
              disabled={adding !== null}
            >
              Load more
            </button>
          )}
        </div>

        <div className="mirror-picker-foot">
          <p role="status" aria-live="polite">
            {adding
              ? stageText(adding, provider.label)
              : 'Mirrored pages are read-only and refresh from the source on demand.'}
          </p>
          {!adding && resources.length > 0 && choosePages}
        </div>
      </div>
    </div>
  );
}
