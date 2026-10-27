/**
 * MirrorBanner (DSK-193): what a mirror page is and what can be done with it,
 * shown where the formatting ribbon would be.
 *
 * A mirror page is read-only, page by page. Its ribbon used to stay fully live
 * (every control dead), typing did nothing without a word, and the only cue
 * that the page was a mirror was the provider mark on its tab. The banner names
 * the source and when it last synced, and carries the actions that used to
 * live only in the tab's right-click menu.
 */
import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, Unlink } from 'lucide-react';

import type { PageMirrorMeta } from '../../types/PageMirror';
import { providerLabel, useIntegrationHubStore } from '../../store/integrationHubStore';
import {
  detachMirrorPageWithConfirm,
  openMirrorSource,
  refreshMirrorPageWithFeedback,
} from '../../services/mirrorPageActions';
import { useTiptapEditor } from '../TiptapEditorContext';
import { ProviderIcon } from './ProviderIcon';
import './MirrorBanner.css';

/** How often the relative sync time re-renders. */
const TICK_MS = 60_000;

/** "just now", "5 min ago", "2 h ago", "3 days ago", then a short date. */
export function syncedLabel(syncedAt: number, now: number = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - syncedAt) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return `on ${new Date(syncedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/** An element that takes typing of its own: an input, a text area or an editable region. */
function isEditableElement(el: HTMLElement): boolean {
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/** A key that would edit the page if it were editable. */
function isEditingKey(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  return e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter';
}

interface MirrorBannerProps {
  pageId: string;
  mirror: PageMirrorMeta;
  /**
   * The phone's bottom bar (DSK-197): two short lines and icon-only, 44px
   * actions in place of the quick formatting bar, whose marks would do nothing.
   */
  compact?: boolean | undefined;
}

export function MirrorBanner({ pageId, mirror, compact = false }: MirrorBannerProps) {
  const hub = useIntegrationHubStore((s) => s.hub);
  const label = providerLabel(hub, mirror.provider);
  const editor = useTiptapEditor();
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [triedToEdit, setTriedToEdit] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Each mirror page explains itself afresh.
  useEffect(() => {
    setTriedToEdit(false);
  }, [pageId]);

  // A keystroke on a read-only page does nothing, silently. Say why.
  //
  // The read-only view is `contenteditable="false"` and cannot take focus, so
  // a keystroke after clicking into the page lands on the document, never on
  // the editor's DOM. Arm on a press inside the page, then watch the document.
  // A key typed into some other editable field does not count.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view.dom;
    let armed = false;
    const onPointerDown = (e: PointerEvent) => {
      armed = e.target instanceof Node && dom.contains(e.target);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!armed || !isEditingKey(e)) return;
      const target = e.target;
      if (target instanceof HTMLElement && !dom.contains(target) && isEditableElement(target)) return;
      setTriedToEdit(true);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [editor]);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    await refreshMirrorPageWithFeedback(pageId);
    setRefreshing(false);
    setNow(Date.now());
  };

  const synced = syncedLabel(mirror.syncedAt, now);

  if (compact) {
    return (
      <div
        className={`mirror-banner mirror-banner--compact${triedToEdit ? ' mirror-banner--explaining' : ''}`}
        role="status"
      >
        <ProviderIcon provider={mirror.provider} size={16} />
        <span className="mirror-banner__text">
          <span className="mirror-banner__title">
            {triedToEdit ? `Read-only. Detach it to edit.` : `${label} mirror · read-only`}
          </span>
          <span className="mirror-banner__sub">Synced {synced}</span>
        </span>
        <div className="mirror-banner__actions">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-busy={refreshing || undefined}
            aria-label={refreshing ? 'Refreshing…' : 'Refresh'}
            title={refreshing ? 'Refreshing…' : 'Refresh'}
          >
            <RefreshCw size={18} aria-hidden="true" className={refreshing ? 'mirror-banner__spin' : undefined} />
          </button>
          {mirror.url && (
            <button
              type="button"
              onClick={() => openMirrorSource(mirror.url!)}
              aria-label={`Open in ${label}`}
              title={`Open in ${label}`}
            >
              <ExternalLink size={18} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={() => void detachMirrorPageWithConfirm(pageId, label)}
            aria-label="Detach"
            title="Detach"
          >
            <Unlink size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="document-editor-toolbar document-editor-toolbar--mirror">
      <div className={`mirror-banner${triedToEdit ? ' mirror-banner--explaining' : ''}`} role="status">
        <ProviderIcon provider={mirror.provider} size={14} />
        <span className="mirror-banner__text">
          {triedToEdit
            ? `This page mirrors ${label} and is read-only. Detach it to edit.`
            : `Mirrored from ${label} · read-only · synced ${synced}`}
        </span>
        <div className="mirror-banner__actions">
          <button type="button" onClick={() => void refresh()} disabled={refreshing} aria-busy={refreshing || undefined}>
            <RefreshCw size={13} aria-hidden="true" className={refreshing ? 'mirror-banner__spin' : undefined} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {mirror.url && (
            <button type="button" onClick={() => openMirrorSource(mirror.url!)}>
              <ExternalLink size={13} aria-hidden="true" />
              Open in {label}
            </button>
          )}
          <button type="button" onClick={() => void detachMirrorPageWithConfirm(pageId, label)}>
            <Unlink size={13} aria-hidden="true" />
            Detach
          </button>
        </div>
      </div>
    </div>
  );
}
