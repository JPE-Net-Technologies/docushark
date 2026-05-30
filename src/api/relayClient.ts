/**
 * Relay REST client.
 *
 * Talks to the standalone docushark-relay binary's HTTP API. Since the
 * relay became a pure OIDC resource server (JP-77) it no longer mints
 * tokens — auth is a Bearer relay app token obtained out-of-band via the
 * Cloud sign-in flow (`cloudAuth.ts`). This client only carries that
 * token; there is no register/login/password surface anymore.
 *
 *   GET    /api/docs            Bearer
 *   GET    /api/docs/:id        Bearer
 *   PUT    /api/docs/:id        Bearer + body
 *   DELETE /api/docs/:id        Bearer
 *   POST   /api/docs/:id/share  Bearer + body
 *   POST   /api/blobs/:hash     Bearer + body
 *   GET    /api/blobs/:hash     Bearer
 *   HEAD   /api/blobs/:hash     Bearer
 */

import type { DiagramDocument, DocumentMetadata } from '../types/Document';
import type { BlobUploadMint } from '../collaboration/BlobSyncService';

/**
 * Default per-request timeout. Bounds a stalled connection so a hung request
 * surfaces as a (retryable) error instead of leaving a relay-doc save stuck
 * "syncing" forever (JP-127). Generous — it's a hang ceiling, not a perf SLA.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Longer ceiling for blob transfers, which move large bodies (up to the relay
 * blob cap). `fetch` exposes no upload progress, so this is a total-time bound,
 * not an idle timeout; an aborted upload is queued (once) by the save layer.
 * Generous so a legitimately slow link finishing a large upload isn't killed
 * mid-flight and re-sent — ~150 MiB completes above ~260 KB/s within this bound
 * (JP-127). A 504 from this timeout is *not* retried in-loop (see
 * `BlobSyncService.shouldRetry`).
 */
const BLOB_TRANSFER_TIMEOUT_MS = 600_000;

// ============ Types ============

/**
 * Thrown for any non-2xx response. Carries the HTTP status and the
 * server-provided error string when available.
 */
export class RelayError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public override readonly message: string,
  ) {
    super(message);
    this.name = 'RelayError';
  }

  /** True for 4xx auth failures — caller may want to re-login. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * Thrown by `saveDocument` when the caller's `expectedVersion` no
 * longer matches the server-side version. Carries `currentVersion` so
 * the caller can refetch, rebase, and retry.
 */
export class VersionConflictError extends RelayError {
  constructor(
    url: string,
    public readonly currentVersion: number,
  ) {
    super(409, url, `Version conflict: server has v${currentVersion}`);
    this.name = 'VersionConflictError';
  }
}

/**
 * Share entry as carried on the wire by `POST /api/docs/:id/share`.
 * Mirrors the relay's `ShareEntry` struct (`relay/src/server/protocol.rs`).
 */
export interface RelayShareEntry {
  userId: string;
  userName: string;
  /** `"viewer" | "editor" | "none"` — `"none"` revokes access. */
  permission: string;
}

// ============ Client ============

export interface RelayClientOptions {
  /** Origin of the relay, e.g. `http://localhost:9876`. No trailing slash. */
  baseUrl: string;
  /** JWT token returned by `login()`. Optional — calls that need it will fail with 401 if missing. */
  token?: string;
  /**
   * Override `fetch` for testing or for environments where the global
   * `fetch` isn't appropriate. Defaults to `globalThis.fetch`.
   */
  fetchImpl?: typeof fetch;
  /**
   * Invoked when an authenticated request returns 401. Use to drop the
   * cached JWT and surface the login UI. Not called for unauthenticated
   * 401s (e.g. a failed `login()` — that already throws RelayError).
   */
  onUnauthorized?: () => void;
  /**
   * Per-request timeout in ms (default 120 000). `0` disables the timeout.
   * Blob transfers use a longer internal ceiling regardless.
   */
  requestTimeoutMs?: number;
}

export class RelayClient {
  private baseUrl: string;
  private token: string | undefined;
  private fetchImpl: typeof fetch;
  private onUnauthorized: (() => void) | undefined;
  private requestTimeoutMs: number;

  constructor(opts: RelayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    if (opts.token !== undefined) {
      this.token = opts.token;
    }
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onUnauthorized = opts.onUnauthorized;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Update the bearer token after a fresh login. Pass undefined to log out. */
  setToken(token: string | undefined): void {
    this.token = token;
  }

  /** Current bearer token (or undefined if unauthenticated). */
  getToken(): string | undefined {
    return this.token;
  }

  /** Register/replace the 401 handler; pass undefined to remove. */
  setOnUnauthorized(handler: (() => void) | undefined): void {
    this.onUnauthorized = handler;
  }

  // ============ Documents ============

  async listDocuments(): Promise<{ documents: DocumentMetadata[] }> {
    return this.requestJson('GET', '/api/docs', { auth: true });
  }

  async getDocument(docId: string): Promise<DiagramDocument> {
    return this.requestJson('GET', `/api/docs/${encodeURIComponent(docId)}`, { auth: true });
  }

  async saveDocument(
    docId: string,
    document: DiagramDocument,
    expectedVersion?: number,
  ): Promise<{ success: boolean; newVersion: number }> {
    const path =
      expectedVersion !== undefined
        ? `/api/docs/${encodeURIComponent(docId)}?expectedVersion=${expectedVersion}`
        : `/api/docs/${encodeURIComponent(docId)}`;
    return this.requestJson('PUT', path, {
      auth: true,
      body: document,
    });
  }

  async deleteDocument(docId: string): Promise<{ success: boolean }> {
    return this.requestJson('DELETE', `/api/docs/${encodeURIComponent(docId)}`, { auth: true });
  }

  async updateDocumentShares(
    docId: string,
    shares: RelayShareEntry[],
  ): Promise<{ success: boolean }> {
    return this.requestJson('POST', `/api/docs/${encodeURIComponent(docId)}/share`, {
      auth: true,
      body: { shares },
    });
  }

  async transferDocumentOwnership(
    docId: string,
    newOwnerId: string,
    newOwnerName: string,
  ): Promise<{ success: boolean }> {
    return this.requestJson('POST', `/api/docs/${encodeURIComponent(docId)}/transfer`, {
      auth: true,
      body: { newOwnerId, newOwnerName },
    });
  }

  // ============ Blobs ============

  async uploadBlob(hash: string, data: Uint8Array): Promise<void> {
    // Copy into a fresh ArrayBuffer so the body is unambiguously BodyInit
    // (strict TS lib defs don't accept `Uint8Array<ArrayBufferLike>` for
    // either BlobPart or BodyInit directly).
    const buffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(buffer).set(data);
    await this.requestRaw('POST', `/api/blobs/${encodeURIComponent(hash)}`, {
      body: buffer,
      contentType: 'application/octet-stream',
      timeoutMs: BLOB_TRANSFER_TIMEOUT_MS,
    });
  }

  async downloadBlob(hash: string): Promise<Uint8Array> {
    const mint = await this.mintBlobGetUrl(hash);
    if (mint.kind === 'presigned') {
      // Fetch the bytes straight from object storage. No `Authorization` (the URL
      // self-authenticates via its query string) and no extra headers, so the
      // browser issues a CORS "simple" GET with a real `Origin` — which the
      // relay's 302-redirect path could not (a followed cross-origin redirect
      // sends `Origin: null`, rejected by R2 CORS).
      const res = await this.fetchWithTimeout(
        mint.url,
        { method: 'GET' },
        BLOB_TRANSFER_TIMEOUT_MS,
      );
      if (!res.ok) {
        throw await buildRelayError(res, mint.url);
      }
      return new Uint8Array(await res.arrayBuffer());
    }
    // Filesystem backend (no presign): proxy the bytes through the relay.
    const res = await this.requestRaw('GET', `/api/blobs/${encodeURIComponent(hash)}`, {
      timeoutMs: BLOB_TRANSFER_TIMEOUT_MS,
    });
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Request a presigned GET so blob bytes download directly from object storage
   * (`POST /api/v1/blobs/:hash/download-url`). Returns `presigned` (fetch the URL
   * directly) or `unsupported` (filesystem backend — `downloadBlob` proxies the
   * GET instead). Mirrors {@link mintBlobPutUrl}; a 409 means the relay can't
   * presign.
   */
  private async mintBlobGetUrl(
    hash: string,
  ): Promise<{ kind: 'presigned'; url: string } | { kind: 'unsupported' }> {
    const path = `/api/v1/blobs/${encodeURIComponent(hash)}/download-url`;
    try {
      const res = await this.requestJson<{ url?: string }>('POST', path, { auth: true });
      if (typeof res.url === 'string') {
        return { kind: 'presigned', url: res.url };
      }
      throw new RelayError(502, `${this.baseUrl}${path}`, 'malformed download-url response');
    } catch (err) {
      // 409 = relay is filesystem-backed (no presign) → caller proxies instead.
      if (err instanceof RelayError && err.status === 409) {
        return { kind: 'unsupported' };
      }
      throw err;
    }
  }

  async blobExists(hash: string): Promise<boolean> {
    try {
      await this.requestRaw('HEAD', `/api/blobs/${encodeURIComponent(hash)}`);
      return true;
    } catch (err) {
      if (err instanceof RelayError && err.status === 404) return false;
      throw err;
    }
  }

  /**
   * Request a presigned PUT so blob bytes upload directly to object storage,
   * bypassing the relay (`POST /api/v1/blobs/:hash/upload-url`). Returns
   * `exists` (dedup), `unsupported` (filesystem backend — use `uploadBlob`), or
   * `presigned` (PUT then `finalizeBlob`). A 507/413 (over quota / too large)
   * propagates as a `RelayError`.
   */
  async mintBlobPutUrl(
    hash: string,
    opts: { size: number; mimeType: string },
  ): Promise<BlobUploadMint> {
    const path = `/api/v1/blobs/${encodeURIComponent(hash)}/upload-url`;
    try {
      const res = await this.requestJson<{
        exists?: boolean;
        url?: string;
        headers?: Record<string, string>;
        expiresAt?: number;
        key?: string;
      }>('POST', path, { auth: true, body: { size: opts.size, mimeType: opts.mimeType } });
      if (res.exists === true) {
        return { kind: 'exists' };
      }
      if (typeof res.url === 'string') {
        return {
          kind: 'presigned',
          url: res.url,
          headers: res.headers ?? {},
          expiresAt: res.expiresAt ?? 0,
          key: res.key ?? '',
        };
      }
      throw new RelayError(502, `${this.baseUrl}${path}`, 'malformed upload-url response');
    } catch (err) {
      // 409 = relay is filesystem-backed (no presign) → caller proxies instead.
      if (err instanceof RelayError && err.status === 409) {
        return { kind: 'unsupported' };
      }
      throw err;
    }
  }

  /**
   * PUT blob bytes directly to a presigned object-storage URL. No
   * `Authorization` is sent (the URL self-authenticates via its query string),
   * and the `Blob` is streamed as the body so a large upload never materializes
   * as an ArrayBuffer on the JS heap. The signed headers (content-type /
   * -length) are echoed so the signature validates.
   */
  async putBlobToUrl(url: string, headers: Record<string, string>, body: Blob): Promise<void> {
    const res = await this.fetchWithTimeout(
      url,
      { method: 'PUT', headers, body },
      BLOB_TRANSFER_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw await buildRelayError(res, url);
    }
  }

  /**
   * Tell the relay a direct upload landed (`POST /api/v1/blobs/:hash/finalize`):
   * it HEADs the object for the authoritative size, enforces the quota, and
   * grants the workspace ACL. A 404 (`object_not_uploaded`) or 507 propagates.
   */
  async finalizeBlob(hash: string, opts: { mimeType: string }): Promise<void> {
    await this.requestJson('POST', `/api/v1/blobs/${encodeURIComponent(hash)}/finalize`, {
      auth: true,
      body: { mimeType: opts.mimeType },
    });
  }

  // ============ Internals ============

  private async requestJson<T>(
    method: string,
    path: string,
    opts: { body?: unknown; auth?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (opts.auth !== false && this.token !== undefined) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }
    const wasAuthed = opts.auth !== false && this.token !== undefined;
    const res = await this.fetchWithTimeout(url, init, opts.timeoutMs ?? this.requestTimeoutMs);
    if (!res.ok) {
      if (res.status === 401 && wasAuthed) {
        this.onUnauthorized?.();
      }
      throw await buildRelayError(res, url);
    }
    // 204 No Content -> return empty object cast to T.
    if (res.status === 204) {
      return {} as T;
    }
    return (await res.json()) as T;
  }

  private async requestRaw(
    method: string,
    path: string,
    opts: { body?: BodyInit; contentType?: string; timeoutMs?: number } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opts.contentType !== undefined) {
      headers['Content-Type'] = opts.contentType;
    }
    if (this.token !== undefined) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      init.body = opts.body;
    }
    const wasAuthed = this.token !== undefined;
    const res = await this.fetchWithTimeout(url, init, opts.timeoutMs ?? this.requestTimeoutMs);
    if (!res.ok) {
      if (res.status === 401 && wasAuthed) {
        this.onUnauthorized?.();
      }
      throw await buildRelayError(res, url);
    }
    return res;
  }

  /**
   * `fetch` with an abort-based timeout. A stalled request is aborted and
   * surfaced as a 504 `RelayError` — numeric status, so `BlobSyncService`
   * retries it and the save layer treats it as transient (queues for replay)
   * instead of leaving the doc stuck "syncing" (JP-127). `timeoutMs <= 0`
   * disables the timeout. The caller's `init` is spread so a future
   * caller-supplied `signal` still works; none does today.
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    if (timeoutMs <= 0) {
      return this.fetchImpl(url, init);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new RelayError(504, url, `Request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Extract a `RelayError` from a non-2xx response. Tries to read a
 * JSON `{ error: string }` body first; falls back to status text. A
 * 409 with `{ errorCode: "VERSION_CONFLICT", currentVersion }` is
 * surfaced as a typed `VersionConflictError` so callers can branch on
 * `instanceof` without sniffing strings.
 */
async function buildRelayError(res: Response, url: string): Promise<RelayError> {
  let message = res.statusText;
  let parsed: unknown;
  try {
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      parsed = await res.json();
      const body = parsed as { error?: string };
      if (typeof body.error === 'string' && body.error.length > 0) {
        message = body.error;
      }
    } else {
      const text = await res.text();
      if (text.length > 0) message = text;
    }
  } catch {
    // Ignore parse errors; fall back to statusText.
  }

  if (
    res.status === 409 &&
    parsed !== null &&
    typeof parsed === 'object' &&
    (parsed as { errorCode?: unknown }).errorCode === 'VERSION_CONFLICT'
  ) {
    const current = (parsed as { currentVersion?: unknown }).currentVersion;
    if (typeof current === 'number') {
      return new VersionConflictError(url, current);
    }
  }

  return new RelayError(res.status, url, message);
}
