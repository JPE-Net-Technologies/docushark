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
}

export class RelayClient {
  private baseUrl: string;
  private token: string | undefined;
  private fetchImpl: typeof fetch;
  private onUnauthorized: (() => void) | undefined;

  constructor(opts: RelayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    if (opts.token !== undefined) {
      this.token = opts.token;
    }
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onUnauthorized = opts.onUnauthorized;
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
    });
  }

  async downloadBlob(hash: string): Promise<Uint8Array> {
    const res = await this.requestRaw('GET', `/api/blobs/${encodeURIComponent(hash)}`);
    return new Uint8Array(await res.arrayBuffer());
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

  // ============ Internals ============

  private async requestJson<T>(
    method: string,
    path: string,
    opts: { body?: unknown; auth?: boolean } = {},
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
    const res = await this.fetchImpl(url, init);
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
    opts: { body?: BodyInit; contentType?: string } = {},
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
    const res = await this.fetchImpl(url, init);
    if (!res.ok) {
      if (res.status === 401 && wasAuthed) {
        this.onUnauthorized?.();
      }
      throw await buildRelayError(res, url);
    }
    return res;
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
