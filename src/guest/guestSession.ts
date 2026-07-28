/**
 * Guest session (JP-464) — the read-only view a stranger gets when opening a
 * published document's share link, `/d/<token>`.
 *
 * The PWA boots with NO session on this route: no relay connection, no cloud
 * sign-in prompt, no library. The Worker on this same origin serves the
 * published artifact (`/api/share/<token>`) and its blobs; this module
 * fetches, hydrates the live stores through the normal migration funnel, and
 * registers an `external` record — which is what makes the entire existing
 * read-only machinery (Engine pan-only, prose non-editable, commands gated,
 * the ribbon) engage without a single new guard.
 *
 * The artifact was projected server-side (allowlist; no identity fields), so
 * nothing here filters content — it renders what it is given.
 */
import { create } from 'zustand';
import { usePersistenceStore } from '../store/persistenceStore';
import { registerBlobDownloader } from '../storage/blobResolver';
import { blobStorage } from '../storage/BlobStorage';
import { DocumentVersionError } from '../migrations/documentMigrations';
import type { DiagramDocument } from '../types/Document';
import type { ExternalDocument } from '../types/DocumentRegistry';

/** `/d/<token>` — the guest route. Token shape mirrors the server's gate. */
const GUEST_PATH = /^\/d\/([A-Za-z0-9_-]{43})$/;

export interface GuestManifestSummary {
  title?: string;
  pageCount?: number;
  shapeCount?: number;
  fileCount?: number;
  publishedAt?: number;
}

export type GuestPhase = 'loading' | 'ready' | 'unavailable' | 'error';

interface GuestState {
  /** Non-null exactly when this tab is a guest view. */
  token: string | null;
  phase: GuestPhase;
  /** Document name for the bar (post-hydration). */
  documentName: string;
  /** Publish time, ms — provenance line on the bar; 0 = unknown. */
  publishedAt: number;
  /** Human-readable failure detail for `error` (never for `unavailable` —
   *  the miss deliberately carries no detail). */
  errorDetail: string;
}

export const useGuestStore = create<GuestState>(() => ({
  token: null,
  phase: 'loading',
  documentName: '',
  publishedAt: 0,
  errorDetail: '',
}));

/** Whether the current location is a guest share route. */
export function guestTokenFromLocation(pathname: string): string | null {
  const match = GUEST_PATH.exec(pathname);
  return match ? match[1]! : null;
}

/** True when this tab is a guest view (any phase). */
export function isGuestSession(): boolean {
  return useGuestStore.getState().token !== null;
}

/**
 * The share artifact is content-only; the editor still needs a document id
 * for store bookkeeping. Derive a stable session-local id from the token so
 * reloads look identical — prefixed so it can never collide with a real
 * relay/local id, and never leaves this tab (external records don't persist).
 */
function guestDocId(token: string): string {
  return `guest-${token.slice(0, 16)}`;
}

/**
 * Boot the guest view for `token`. Fetches the artifact + manifest summary,
 * hydrates the editor, and registers the share-scoped blob downloader.
 * Resolves when the store phase is terminal (`ready` / `unavailable` /
 * `error`); the caller mounts the shell either way.
 */
export async function bootGuestSession(token: string): Promise<void> {
  useGuestStore.setState({ token, phase: 'loading' });

  let artifact: DiagramDocument;
  let manifest: GuestManifestSummary = {};
  try {
    const res = await fetch(`/api/share/${encodeURIComponent(token)}`, {
      headers: { accept: 'application/json' },
    });
    if (res.status === 404) {
      // Revoked, unknown, malformed — one state, matching the server's
      // deliberate refusal to distinguish them.
      useGuestStore.setState({ phase: 'unavailable' });
      return;
    }
    if (!res.ok) {
      useGuestStore.setState({
        phase: 'error',
        errorDetail: `The document service returned ${res.status}. Try again in a minute.`,
      });
      return;
    }
    artifact = (await res.json()) as DiagramDocument;
  } catch {
    useGuestStore.setState({
      phase: 'error',
      errorDetail: 'Could not reach the document service. Check your connection and retry.',
    });
    return;
  }

  // Display summary for the bar's provenance line — a server-side projection
  // of the manifest (title/counts/publishedAt only; the manifest itself, with
  // its storage keys, never leaves the server). Best-effort: the document
  // renders fine without it.
  try {
    const res = await fetch(`/api/share/${encodeURIComponent(token)}/meta`, {
      headers: { accept: 'application/json' },
    });
    if (res.ok) manifest = (await res.json()) as GuestManifestSummary;
  } catch {
    /* provenance degrades to blank; content is unaffected */
  }

  // Blob resolution for the snapshot: the share blob endpoint, authorized by
  // the artifact's manifest server-side. Stored content-addressed locally, so
  // the id IS the hash and the in-document `blob://` URIs resolve untouched.
  registerBlobDownloader(async (hash) => {
    try {
      const res = await fetch(`/api/share/${encodeURIComponent(token)}/blobs/${hash}`);
      if (!res.ok) return false;
      const blob = await res.blob();
      await blobStorage.saveBlob(blob, hash);
      return true;
    } catch {
      return false;
    }
  });

  const id = guestDocId(token);
  const name =
    (typeof artifact.name === 'string' && artifact.name) || manifest.title || 'Untitled document';
  const now = Date.now();
  const record: ExternalDocument = {
    type: 'external',
    source: 'share-link',
    id,
    name,
    pageCount: manifest.pageCount ?? artifact.pageOrder?.length ?? 1,
    createdAt: manifest.publishedAt ?? now,
    modifiedAt: manifest.publishedAt ?? now,
    ...(manifest.publishedAt !== undefined ? { publishedAt: manifest.publishedAt } : {}),
  };

  try {
    usePersistenceStore.getState().loadExternalDocument({ ...artifact, id, name }, record);
  } catch (e) {
    useGuestStore.setState({
      phase: 'error',
      errorDetail:
        e instanceof DocumentVersionError
          ? 'This document was published from a newer DocuShark. Refresh to update, then retry.'
          : 'This document could not be opened.',
    });
    return;
  }

  useGuestStore.setState({
    phase: 'ready',
    documentName: name,
    publishedAt: manifest.publishedAt ?? 0,
  });
}
