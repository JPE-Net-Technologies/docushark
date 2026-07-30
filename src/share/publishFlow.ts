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

// ── Restore carry (JP-470) ───────────────────────────────────────────────────
//
// Restore retires a doc id and mints a successor; the relay carries the frozen
// publish artifact across and reports the new object keys in its ack. The
// editor's half is moving the share ROW (the public URL's token) to the new
// id. A failed move must not fork the URL forever, so the failure is stashed
// as a pending-repoint breadcrumb that `PublishRung` retries when it next
// observes the telltale state (relay says published, control plane has no
// row for this doc).

export interface RepointKeys {
  artifactKey: string;
  manifestKey: string;
  publishedBytes?: number;
}

export interface PendingRepoint extends RepointKeys {
  previousDocId: string;
}

const PENDING_REPOINT_PREFIX = 'docushark:pending-repoint:';

/** Persist a failed repoint for the rung's retry. Best-effort (private mode). */
export function stashPendingRepoint(newDocId: string, payload: PendingRepoint): void {
  try {
    localStorage.setItem(PENDING_REPOINT_PREFIX + newDocId, JSON.stringify(payload));
  } catch {
    /* storage unavailable — the toast already told the user */
  }
}

/** The stashed repoint for `newDocId`, if any. Cleared only on success. */
export function readPendingRepoint(newDocId: string): PendingRepoint | null {
  try {
    const raw = localStorage.getItem(PENDING_REPOINT_PREFIX + newDocId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingRepoint>;
    if (!parsed.previousDocId || !parsed.artifactKey || !parsed.manifestKey) return null;
    return parsed as PendingRepoint;
  } catch {
    return null;
  }
}

export function clearPendingRepoint(newDocId: string): void {
  try {
    localStorage.removeItem(PENDING_REPOINT_PREFIX + newDocId);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Move the share row from a retired doc id to its restore successor — same
 * token, same view count, revocation state preserved (server-side move,
 * migration 0022). Never throws; the caller decides between the breadcrumb
 * (transient failure) and giving up (forbidden — only the link's creator or
 * a workspace owner may retarget a public token).
 */
export async function repointShareLink(
  previousDocId: string,
  newDocId: string,
  keys: RepointKeys,
): Promise<{ ok: true } | { ok: false; retryable: boolean; detail: string }> {
  try {
    await webClient.mintShareLink(newDocId, { ...keys, previousDocId });
    return { ok: true };
  } catch (e) {
    const forbidden = e instanceof WebClientError && e.code === 'forbidden';
    return {
      ok: false,
      retryable: !forbidden,
      detail: forbidden
        ? 'Only the link creator or a workspace owner can move the public link.'
        : e instanceof Error
          ? e.message
          : String(e),
    };
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
