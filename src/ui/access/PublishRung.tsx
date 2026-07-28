/**
 * Publish rung of the access ladder (JP-464) — "anyone with the link can
 * view", the widest grant on the ladder and therefore its last rung.
 *
 * The states the rung renders map one-to-one to the design's status table:
 *
 *   unpublished          → one primary action: Publish
 *   published, current   → the link, Copy, view count, published date
 *   published, stale     → the above + "changed since publishing" + Republish
 *   over the cap         → the LINK STAYS UP on the last snapshot; republish
 *                          is blocked with the configured number, never a
 *                          silent failure and never an auto-revoke (a link
 *                          embedded in an article must not die because the
 *                          source grew)
 *   turned off           → Publish re-enables the SAME URL (deliberate:
 *                          Google-Docs semantics, article links survive)
 *
 * Size handling is warn-then-confirm: ≥80% of the cap shows an inline note;
 * at/over the cap the publish button still works but leads with a
 * confirmation that explains the refusal will come from the relay. All
 * numbers render from the status endpoint — no client-side copy of the cap.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Eye, Globe, Loader2, RefreshCw } from 'lucide-react';
import { getDocProvider } from '../../store/relayDocumentStore';
import { useDocumentRegistry } from '../../store/documentRegistry';
import { webClient, WebClientError, type ShareLink } from '../../api/webClient';
import type { RelayPublishStatus } from '../../api/relayClient';
import {
  publishDocument,
  unpublishDocument,
  shareUrlFor,
  type PublishOutcome,
} from '../../share/publishFlow';
import { confirmDialog } from '../confirm/confirmStore';

export interface PublishRungProps {
  documentId: string;
  /** Whether the caller may publish (doc owner or workspace owner). */
  canManage: boolean;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function formatDay(input: number | string | null | undefined): string {
  if (!input) return '';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

export function PublishRung({ documentId, canManage }: PublishRungProps) {
  const [status, setStatus] = useState<RelayPublishStatus | null>(null);
  const [link, setLink] = useState<ShareLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const document = useDocumentRegistry((s) => s.entries[documentId]?.document);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const provider = getDocProvider();
      const [s, l] = await Promise.all([
        provider?.getPublishStatus?.(documentId) ?? Promise.resolve(null),
        webClient.getShareLink(documentId).catch((e: unknown) => {
          // A workspace without the control plane (self-host) has no links;
          // publish state still renders from the relay half.
          if (e instanceof WebClientError && e.status === 0) return null;
          throw e;
        }),
      ]);
      setStatus(s);
      setLink(l);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load publish state');
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Advisory size estimate from the in-memory body — the projection drops
   * fields, so this slightly OVERSTATES the artifact, which is the safe
   * direction for a warning. The relay's post-flush measurement is the
   * authority; this only decides whether to warn before the round-trip.
   */
  const estimatedBytes = useMemo(() => {
    if (!document) return 0;
    try {
      return JSON.stringify(document).length;
    } catch {
      return 0;
    }
  }, [document]);

  const maxBytes = status?.maxBytes ?? null;
  const nearCap = maxBytes !== null && estimatedBytes >= maxBytes * 0.8 && estimatedBytes <= maxBytes;
  const overCap = maxBytes !== null && estimatedBytes > maxBytes;

  const liveLink = link && link.revokedAt === null ? link : null;
  const published = status?.published ?? false;
  const url = liveLink ? shareUrlFor(liveLink.token) : null;

  const failureMessage = (outcome: Extract<PublishOutcome, { ok: false }>): string => {
    switch (outcome.kind) {
      case 'too-large':
        return `This document is ${formatBytes(outcome.sizeBytes)} — over the ${formatBytes(outcome.maxBytes)} publishing limit. The current published version (if any) is untouched; make the document smaller and republish.`;
      case 'quota':
        return 'Publishing stores a public copy, and your workspace is out of storage. Free some space and try again.';
      case 'forbidden':
        return 'Only this document’s owner (or a workspace owner) can publish it.';
      case 'link-mint-failed':
        return `The document was published, but the link could not be ${published ? 'refreshed' : 'created'}: ${outcome.detail}`;
      case 'error':
        return outcome.detail;
    }
  };

  const handlePublish = useCallback(async () => {
    setError(null);
    // At/over the cap the relay will refuse — lead with that instead of a
    // surprise error. The user may still try (the estimate can overstate).
    if (overCap && maxBytes !== null) {
      const ok = await confirmDialog({
        title: 'Probably too large to publish',
        message: `This document is about ${formatBytes(estimatedBytes)}; the publishing limit is ${formatBytes(maxBytes)}.`,
        details:
          'Publishing will likely be refused. Nothing already published is affected. You can reduce the document (large tables and pasted text are the usual culprits — images don’t count) and try again.',
        confirmLabel: 'Try anyway',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const outcome = await publishDocument(documentId);
      if (!outcome.ok) {
        setError(failureMessage(outcome));
        // The relay half may have succeeded (mint failures) — re-read truth.
        await refresh();
        return;
      }
      setLink(outcome.link);
      await refresh();
      // Copy immediately on FIRST publish: the reason someone publishes is to
      // paste the link somewhere, so save them the second click. Never on
      // republish (their clipboard is not ours to overwrite in a refresh).
      if (!published && navigator.clipboard) {
        void navigator.clipboard.writeText(shareUrlFor(outcome.link.token)).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }
    } finally {
      setBusy(false);
    }
  }, [documentId, estimatedBytes, maxBytes, overCap, published, refresh]);

  const handleUnpublish = useCallback(async () => {
    const ok = await confirmDialog({
      title: 'Turn off the public link?',
      message: 'Anyone opening the link will see “document unavailable” within a minute.',
      details:
        'The link address is kept: publishing again later turns the SAME link back on, so a link in a published article can be restored.',
      confirmLabel: 'Turn off link',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await unpublishDocument(documentId);
      if (!outcome.ok) setError(outcome.detail);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [documentId, refresh]);

  const handleCopy = useCallback(() => {
    if (!url || !navigator.clipboard) return;
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }, [url]);

  if (loading) {
    return (
      <p className="access-panel__loading" role="status">
        <Loader2 size={14} className="access-panel__spin" aria-hidden="true" /> Checking publish
        state…
      </p>
    );
  }

  return (
    <div className="access-rung__content publish-rung">
      {published && url ? (
        <>
          <div className="publish-rung__linkrow">
            <Globe size={14} aria-hidden="true" className="publish-rung__globe" />
            <input
              className="publish-rung__url"
              value={url}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Public link"
            />
            <button
              type="button"
              className="access-panel__btn access-panel__btn--compact"
              onClick={handleCopy}
              disabled={busy}
            >
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <p className="publish-rung__meta">
            <Eye size={12} aria-hidden="true" />{' '}
            {link ? `${link.viewCount} ${link.viewCount === 1 ? 'view' : 'views'}` : ''}
            {status?.publishedAt ? ` · Published ${formatDay(status.publishedAt)}` : ''}
            {status?.bytes ? ` · ${formatBytes(status.bytes)} of storage` : ''}
          </p>

          {status?.stale ? (
            <div className="publish-rung__notice" role="status">
              <span>The document has changed since it was published — readers see the older version.</span>
              {canManage ? (
                <button
                  type="button"
                  className="access-panel__btn access-panel__btn--primary"
                  onClick={() => void handlePublish()}
                  disabled={busy}
                >
                  {busy ? (
                    <Loader2 size={14} className="access-panel__spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw size={14} aria-hidden="true" />
                  )}
                  Republish
                </button>
              ) : null}
            </div>
          ) : null}

          {canManage ? (
            <div className="publish-rung__footer">
              <button
                type="button"
                className="access-panel__btn"
                onClick={() => void handleUnpublish()}
                disabled={busy}
              >
                Turn off link
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <p className="access-panel__hint">
            Publish a read-only snapshot anyone with the link can view — no account needed.
            Readers see the version you publish, not your live edits. The public copy uses
            document-size storage.
          </p>
          {link && link.revokedAt !== null ? (
            <p className="publish-rung__meta">
              This document had a link before — publishing turns the <b>same address</b> back on.
            </p>
          ) : null}
          {canManage ? (
            <button
              type="button"
              className="access-panel__btn access-panel__btn--primary"
              onClick={() => void handlePublish()}
              disabled={busy}
            >
              {busy ? (
                <Loader2 size={14} className="access-panel__spin" aria-hidden="true" />
              ) : (
                <Globe size={14} aria-hidden="true" />
              )}
              Publish to the web
            </button>
          ) : (
            <p className="access-panel__hint">Only the document’s owner can publish it.</p>
          )}
        </>
      )}

      {nearCap && maxBytes !== null ? (
        <p className="publish-rung__notice publish-rung__notice--soft">
          This document is near the {formatBytes(maxBytes)} publishing limit
          (about {formatBytes(estimatedBytes)}). Images don’t count toward it.
        </p>
      ) : null}

      {error ? (
        <p className="access-panel__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default PublishRung;
