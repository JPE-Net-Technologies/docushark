/**
 * Publish orchestration (JP-464): the two-system handshake behind the
 * Publish rung.
 *
 * Order is load-bearing, in both directions:
 *
 * - PUBLISH: relay first (writes the sanitized artifact; owner-gated there),
 *   control-plane row second. The ROW is the read-side commit point — if the
 *   mint fails, the artifact exists but no URL resolves (safe, retryable);
 *   the reverse order could mint a link that 404s for a reader.
 * - UNPUBLISH: row first (revoking the row is what makes the URL dark),
 *   relay second (deletes the artifact, frees the metered bytes). If the
 *   relay half fails the link is already dead and only quota is stale —
 *   corrected by the next publish/unpublish.
 *
 * Errors are returned typed, not thrown: the rung renders each failure
 * differently (cap exceeded shows the configured number, quota points at
 * storage, network says retry), and the distinction is the UX.
 */
import { flushAutoSaveNow } from '../store/autoSaveGuard';
import { getDocProvider } from '../store/relayDocumentStore';
import { webClient, WebClientError, type ShareLink } from '../api/webClient';
import { RelayError } from '../api/relayClient';

export type PublishFailure =
  | { kind: 'too-large'; sizeBytes: number; maxBytes: number }
  | { kind: 'quota' }
  | { kind: 'forbidden' }
  | { kind: 'link-mint-failed'; detail: string }
  | { kind: 'error'; detail: string };

export type PublishOutcome =
  | { ok: true; link: ShareLink; bytes: number }
  | ({ ok: false } & PublishFailure);

/** The public URL for a share token — same origin as the editor by design
 *  (the serving Worker routes `/d/*` on this very host). */
export function shareUrlFor(token: string): string {
  return `${window.location.origin}/d/${token}`;
}

export async function publishDocument(docId: string): Promise<PublishOutcome> {
  const provider = getDocProvider();
  if (!provider?.publishDocument) {
    return { ok: false, kind: 'error', detail: 'Not connected to your workspace.' };
  }

  // Push any debounced local edit before snapshotting; the relay also
  // flushes live CRDT state server-side, so the artifact reflects "now"
  // from both directions.
  flushAutoSaveNow();

  let ack;
  try {
    ack = await provider.publishDocument(docId);
  } catch (e) {
    if (e instanceof RelayError) {
      if (e.status === 413 && e.body && typeof e.body === 'object') {
        const body = e.body as { sizeBytes?: number; maxBytes?: number };
        return {
          ok: false,
          kind: 'too-large',
          sizeBytes: body.sizeBytes ?? 0,
          maxBytes: body.maxBytes ?? 0,
        };
      }
      if (e.status === 507) return { ok: false, kind: 'quota' };
      if (e.status === 403) return { ok: false, kind: 'forbidden' };
    }
    return { ok: false, kind: 'error', detail: e instanceof Error ? e.message : String(e) };
  }

  if (!ack.artifactKey || !ack.manifestKey) {
    // Filesystem-backend relay (self-host): the artifact exists on the relay
    // volume, but this deployment has no link-serving surface to point at.
    return {
      ok: false,
      kind: 'error',
      detail: 'This relay has no public serving configured — the projection was written locally.',
    };
  }

  try {
    const link = await webClient.mintShareLink(docId, {
      artifactKey: ack.artifactKey,
      manifestKey: ack.manifestKey,
      publishedBytes: ack.bytes,
    });
    return { ok: true, link, bytes: ack.bytes };
  } catch (e) {
    // The artifact IS published relay-side; only the URL is missing. Say so
    // precisely — "retry" here means retrying the mint, not re-publishing.
    const detail =
      e instanceof WebClientError && e.code === 'forbidden'
        ? 'This link was turned off by its owner; only they (or a workspace owner) can turn it back on.'
        : e instanceof Error
          ? e.message
          : String(e);
    return { ok: false, kind: 'link-mint-failed', detail };
  }
}

export type UnpublishOutcome = { ok: true } | { ok: false; detail: string };

export async function unpublishDocument(docId: string): Promise<UnpublishOutcome> {
  // Row first: the URL must die even if the relay half fails.
  try {
    await webClient.revokeShareLink(docId);
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  try {
    const provider = getDocProvider();
    await provider?.unpublishDocument?.(docId);
  } catch {
    // Link is already dark; the artifact's metered bytes linger until the
    // next publish/unpublish round-trip. Not worth failing the action over.
  }
  return { ok: true };
}
