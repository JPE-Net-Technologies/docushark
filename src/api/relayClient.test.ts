import { describe, it, expect, beforeEach } from 'vitest';
import {
  RelayClient,
  RelayError,
  VersionConflictError,
  isTransientAuthFailure,
} from './relayClient';

/** Minimal scriptable fetch mock. Each test queues responses in order. */
class FetchScript {
  public calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string | undefined }> = [];
  private queue: Array<() => Response> = [];

  /** Push a JSON success response (default 200). */
  pushJson(body: unknown, status = 200): this {
    this.queue.push(
      () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    return this;
  }

  /** Push a JSON error response with an `{error}` body. */
  pushError(status: number, errorMessage: string): this {
    this.queue.push(
      () =>
        new Response(JSON.stringify({ error: errorMessage }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    return this;
  }

  /** Push a raw binary response (used for blob downloads). */
  pushBinary(data: Uint8Array, status = 200): this {
    // Copy into a fresh ArrayBuffer so the Response body is unambiguously
    // a concrete BodyInit (avoids the Uint8Array<ArrayBufferLike> /
    // SharedArrayBuffer type wrinkle in the strict TS lib defs).
    const ab = new ArrayBuffer(data.byteLength);
    new Uint8Array(ab).set(data);
    this.queue.push(
      () =>
        new Response(ab, {
          status,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
    );
    return this;
  }

  /** Push a 409 with the VERSION_CONFLICT error-code body. */
  queue409VersionConflict(currentVersion: number): this {
    this.queue.push(
      () =>
        new Response(
          JSON.stringify({ errorCode: 'VERSION_CONFLICT', currentVersion }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    return this;
  }

  /** Push a bare 204 No Content. */
  pushNoContent(): this {
    this.queue.push(() => new Response(null, { status: 204 }));
    return this;
  }

  /** Push an empty 404 with no body — exercises the fallback message path. */
  pushNotFound(): this {
    this.queue.push(() => new Response(null, { status: 404, statusText: 'Not Found' }));
    return this;
  }

  fetch: typeof fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString();
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    const raw = init.headers ?? {};
    if (raw instanceof Headers) {
      raw.forEach((v, k) => (headers[k.toLowerCase()] = v));
    } else if (Array.isArray(raw)) {
      for (const [k, v] of raw) headers[k.toLowerCase()] = v;
    } else {
      for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
    }
    const body = typeof init.body === 'string' ? init.body : undefined;
    this.calls.push({ url, method, headers, body });

    const producer = this.queue.shift();
    if (!producer) {
      throw new Error(`FetchScript: no response queued for ${method} ${url}`);
    }
    return producer();
  };
}

describe('RelayClient', () => {
  let script: FetchScript;

  beforeEach(() => {
    script = new FetchScript();
  });

  it('strips trailing slashes from baseUrl', () => {
    const client = new RelayClient({ baseUrl: 'http://relay/', fetchImpl: script.fetch });
    expect(client).toBeDefined();
    // We can't directly observe the stripped baseUrl, but a follow-up
    // call will land on http://relay/api/... without a double slash.
    script.pushJson({ documents: [] });
    return client.listDocuments().then(() => {
      expect(script.calls[0]?.url).toBe('http://relay/api/docs');
    });
  });

  describe('token', () => {
    it('carries the Bearer token on authed calls', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'JWT-XYZ', fetchImpl: script.fetch });
      expect(client.getToken()).toBe('JWT-XYZ');
      script.pushJson({ documents: [] });
      await client.listDocuments();
      expect(script.calls[0]?.headers['authorization']).toBe('Bearer JWT-XYZ');
    });

    it('setToken updates the bearer for subsequent calls', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', fetchImpl: script.fetch });
      expect(client.getToken()).toBeUndefined();
      client.setToken('NEW');
      expect(client.getToken()).toBe('NEW');
      script.pushJson({ documents: [] });
      await client.listDocuments();
      expect(script.calls[0]?.headers['authorization']).toBe('Bearer NEW');
    });

    it('setToken(undefined) clears the bearer', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      client.setToken(undefined);
      script.pushJson({ documents: [] });
      await client.listDocuments();
      expect(script.calls[0]?.headers['authorization']).toBeUndefined();
    });
  });

  describe('documents', () => {
    it('listDocuments sends Bearer + returns documents array', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushJson({
        documents: [{ id: 'doc-1', name: 'Doc', pageCount: 1, modifiedAt: 1, createdAt: 1 }],
      });
      const { documents } = await client.listDocuments();
      expect(documents).toHaveLength(1);
      expect(script.calls[0]?.headers['authorization']).toBe('Bearer T');
    });

    it('getUsage GETs /api/v1/usage with Bearer and returns the usage body', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushJson({ storageBytes: 1234, storageQuota: 5000, activeEditors: 1, editorLimit: 2 });
      const usage = await client.getUsage();
      expect(script.calls[0]?.url).toBe('http://r/api/v1/usage');
      expect(script.calls[0]?.headers['authorization']).toBe('Bearer T');
      expect(usage).toEqual({ storageBytes: 1234, storageQuota: 5000, activeEditors: 1, editorLimit: 2 });
    });

    it('getDocument URL-encodes the doc id', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushJson({ id: 'a b/c', name: 'odd' });
      await client.getDocument('a b/c');
      expect(script.calls[0]?.url).toBe('http://r/api/docs/a%20b%2Fc');
    });

    it('saveDocument PUTs JSON body and returns newVersion', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushJson({ success: true, newVersion: 4 });
      const doc = {
        id: 'doc-1',
        name: 'Test',
        version: 1,
        pages: [],
        createdAt: 1,
        modifiedAt: 1,
      } as unknown as Parameters<typeof client.saveDocument>[1];
      const result = await client.saveDocument('doc-1', doc);
      const call = script.calls[0]!;
      expect(call.method).toBe('PUT');
      expect(call.url).toBe('http://r/api/docs/doc-1');
      expect(JSON.parse(call.body!).id).toBe('doc-1');
      expect(result).toEqual({ success: true, newVersion: 4 });
    });

    it('saveDocument threads expectedVersion as query param', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushJson({ success: true, newVersion: 7 });
      const doc = { id: 'doc-1' } as unknown as Parameters<typeof client.saveDocument>[1];
      await client.saveDocument('doc-1', doc, 6);
      expect(script.calls[0]?.url).toBe('http://r/api/docs/doc-1?expectedVersion=6');
    });

    it('saveDocument throws VersionConflictError on 409', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.queue409VersionConflict(11);
      const doc = { id: 'doc-1' } as unknown as Parameters<typeof client.saveDocument>[1];
      try {
        await client.saveDocument('doc-1', doc, 5);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(VersionConflictError);
        expect(err).toBeInstanceOf(RelayError);
        const ve = err as VersionConflictError;
        expect(ve.status).toBe(409);
        expect(ve.currentVersion).toBe(11);
      }
    });

    it('updateDocumentShares POSTs shares array to /share', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushJson({ success: true });
      await client.updateDocumentShares('doc-1', [
        { userId: 'u-2', userName: 'Bob', permission: 'editor' },
      ]);
      const call = script.calls[0]!;
      expect(call.method).toBe('POST');
      expect(call.url).toBe('http://r/api/docs/doc-1/share');
      expect(JSON.parse(call.body!)).toEqual({
        shares: [{ userId: 'u-2', userName: 'Bob', permission: 'editor' }],
      });
    });

    it('transferDocumentOwnership POSTs newOwner fields to /transfer', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushJson({ success: true });
      await client.transferDocumentOwnership('doc-1', 'u-2', 'Bob');
      const call = script.calls[0]!;
      expect(call.method).toBe('POST');
      expect(call.url).toBe('http://r/api/docs/doc-1/transfer');
      expect(JSON.parse(call.body!)).toEqual({ newOwnerId: 'u-2', newOwnerName: 'Bob' });
    });

    it('deleteDocument returns success ack', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushJson({ success: true });
      const result = await client.deleteDocument('doc-1');
      expect(result.success).toBe(true);
      expect(script.calls[0]?.method).toBe('DELETE');
    });

    it('forbidden response maps to RelayError(403) with isAuthError=true', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushError(403, 'ERR_VIEW_FORBIDDEN: missing permission');
      try {
        await client.getDocument('doc-1');
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RelayError);
        const re = err as RelayError;
        expect(re.status).toBe(403);
        expect(re.isAuthError).toBe(true);
        expect(re.message).toContain('ERR_VIEW_FORBIDDEN');
      }
    });
  });

  describe('collections (JP-159)', () => {
    it('getCollections GETs /api/collections', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushJson({ collections: [{ id: 'A', name: 'Alpha', order: 0 }] });
      const out = await client.getCollections();
      expect(script.calls[0]?.method).toBe('GET');
      expect(script.calls[0]?.url).toBe('http://r/api/collections');
      expect(out.collections[0]?.id).toBe('A');
    });

    it('setCollections PUTs the wrapped set', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushJson({ success: true });
      await client.setCollections([{ id: 'A', name: 'Alpha', order: 0 }]);
      const call = script.calls[0]!;
      expect(call.method).toBe('PUT');
      expect(call.url).toBe('http://r/api/collections');
      expect(JSON.parse(call.body!)).toEqual({ collections: [{ id: 'A', name: 'Alpha', order: 0 }] });
    });

    it('setDocumentCollection PUTs collectionId to /collection (null clears)', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushJson({ success: true });
      await client.setDocumentCollection('doc-1', 'A');
      expect(script.calls[0]?.method).toBe('PUT');
      expect(script.calls[0]?.url).toBe('http://r/api/docs/doc-1/collection');
      expect(JSON.parse(script.calls[0]!.body!)).toEqual({ collectionId: 'A' });

      script.pushJson({ success: true });
      await client.setDocumentCollection('doc-1', null);
      expect(JSON.parse(script.calls[1]!.body!)).toEqual({ collectionId: null });
    });
  });

  describe('blobs', () => {
    it('uploadBlob POSTs raw bytes with octet-stream content type', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushNoContent();
      const bytes = new Uint8Array([1, 2, 3, 4]);
      await client.uploadBlob('abc123', bytes);
      const call = script.calls[0]!;
      expect(call.url).toBe('http://r/api/blobs/abc123');
      expect(call.method).toBe('POST');
      expect(call.headers['content-type']).toBe('application/octet-stream');
    });

    it('downloadBlob mints a presigned URL then fetches the bytes directly', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushJson({ url: 'https://r2.example/blob?sig=abc' });
      script.pushBinary(new Uint8Array([42, 43, 44]));
      const data = await client.downloadBlob('abc123');
      expect(Array.from(data)).toEqual([42, 43, 44]);
      // First call: authed mint POST to the download-url endpoint.
      expect(script.calls[0]!.url).toBe('http://r/api/v1/blobs/abc123/download-url');
      expect(script.calls[0]!.method).toBe('POST');
      expect(script.calls[0]!.headers['authorization']).toBe('Bearer T');
      // Second call: bytes fetched straight from the presigned URL, NO auth header
      // (the URL self-authenticates; a forwarded bearer would leak / be rejected).
      expect(script.calls[1]!.url).toBe('https://r2.example/blob?sig=abc');
      expect(script.calls[1]!.method).toBe('GET');
      expect(script.calls[1]!.headers['authorization']).toBeUndefined();
    });

    it('downloadBlob falls back to the proxy GET when presign is unsupported (409)', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushError(409, 'presign_unsupported');
      script.pushBinary(new Uint8Array([7, 8, 9]));
      const data = await client.downloadBlob('abc123');
      expect(Array.from(data)).toEqual([7, 8, 9]);
      // Falls back to the relay proxy GET (filesystem backend), authed.
      expect(script.calls[1]!.url).toBe('http://r/api/blobs/abc123');
      expect(script.calls[1]!.method).toBe('GET');
      expect(script.calls[1]!.headers['authorization']).toBe('Bearer T');
    });

    it('blobExists returns true on 2xx', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushNoContent();
      expect(await client.blobExists('abc')).toBe(true);
    });

    it('blobExists returns false on 404 (does not throw)', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushNotFound();
      expect(await client.blobExists('abc')).toBe(false);
    });

    it('blobExists rethrows non-404 errors', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushError(500, 'storage error');
      await expect(client.blobExists('abc')).rejects.toBeInstanceOf(RelayError);
    });
  });

  describe('401 interceptor', () => {
    it('fires onUnauthorized when an authed request returns 401', async () => {
      let fired = 0;
      const client = new RelayClient({
        baseUrl: 'http://r',
        token: 'T',
        fetchImpl: script.fetch,
        onUnauthorized: () => fired++,
      });
      script.pushError(401, 'token expired');
      await expect(client.listDocuments()).rejects.toBeInstanceOf(RelayError);
      expect(fired).toBe(1);
    });

    it('does NOT fire onUnauthorized when an unauthenticated request returns 401', async () => {
      let fired = 0;
      const client = new RelayClient({
        baseUrl: 'http://r',
        fetchImpl: script.fetch,
        onUnauthorized: () => fired++,
      });
      // No token set → wasAuthed is false, so the interceptor stays quiet.
      script.pushError(401, 'missing bearer token');
      await expect(client.listDocuments()).rejects.toBeInstanceOf(RelayError);
      expect(fired).toBe(0);
    });

    it('does NOT fire onUnauthorized on non-401 errors', async () => {
      let fired = 0;
      const client = new RelayClient({
        baseUrl: 'http://r',
        token: 'T',
        fetchImpl: script.fetch,
        onUnauthorized: () => fired++,
      });
      script.pushError(500, 'boom');
      await expect(client.listDocuments()).rejects.toBeInstanceOf(RelayError);
      expect(fired).toBe(0);
    });
  });

  describe('error handling', () => {
    it('falls back to statusText when no JSON body is present', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', fetchImpl: script.fetch });
      script.pushNotFound();
      try {
        await client.getDocument('missing');
        throw new Error('should have thrown');
      } catch (err) {
        const re = err as RelayError;
        expect(re.status).toBe(404);
        expect(re.message).toBe('Not Found');
      }
    });
  });
});

describe('RelayClient — request timeout (JP-127)', () => {
  it('aborts a stalled request and surfaces a 504 RelayError', async () => {
    // A fetch that never resolves until its signal is aborted — mimics a hung
    // upload with no server response. Pre-fix this hung forever, leaving a
    // relay doc stuck "syncing".
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      })) as unknown as typeof fetch;

    const client = new RelayClient({
      baseUrl: 'http://relay.test',
      token: 't',
      fetchImpl,
      requestTimeoutMs: 20,
    });

    // blobExists only swallows a 404; the 504 timeout error propagates.
    await expect(client.blobExists('abc')).rejects.toMatchObject({
      name: 'RelayError',
      status: 504,
    });
  });

  it('passes through normally when fetch resolves before the timeout', async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch;
    const client = new RelayClient({
      baseUrl: 'http://relay.test',
      token: 't',
      fetchImpl,
      requestTimeoutMs: 1000,
    });
    await expect(client.blobExists('abc')).resolves.toBe(false);
  });

  it('does not arm a timeout (no AbortSignal) when requestTimeoutMs is 0', async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeUndefined();
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const client = new RelayClient({
      baseUrl: 'http://relay.test',
      token: 't',
      fetchImpl,
      requestTimeoutMs: 0,
    });
    await expect(client.blobExists('abc')).resolves.toBe(false);
  });
});

describe('401 discrimination (JP-396)', () => {
  let script: FetchScript;
  beforeEach(() => {
    script = new FetchScript();
  });

  it('does NOT call onUnauthorized for a transient jwks-unavailable 401 (still throws)', async () => {
    let unauthorized = 0;
    const client = new RelayClient({
      baseUrl: 'http://r',
      token: 'T',
      fetchImpl: script.fetch,
      onUnauthorized: () => {
        unauthorized++;
      },
    });
    // The cold-relay 401: a relay-availability failure, not a token rejection.
    script.pushError(401, 'invalid token: jwks unavailable (fail-open grace expired)');

    await expect(client.listDocuments()).rejects.toBeInstanceOf(RelayError);
    expect(unauthorized).toBe(0); // session must NOT be torn down
  });

  it('DOES call onUnauthorized for a genuine token rejection 401', async () => {
    let unauthorized = 0;
    const client = new RelayClient({
      baseUrl: 'http://r',
      token: 'T',
      fetchImpl: script.fetch,
      onUnauthorized: () => {
        unauthorized++;
      },
    });
    script.pushError(401, 'invalid token: ExpiredSignature');

    await expect(client.listDocuments()).rejects.toBeInstanceOf(RelayError);
    expect(unauthorized).toBe(1);
  });

  it('does not call onUnauthorized for a 403 (only 401 triggers it)', async () => {
    let unauthorized = 0;
    const client = new RelayClient({
      baseUrl: 'http://r',
      token: 'T',
      fetchImpl: script.fetch,
      onUnauthorized: () => {
        unauthorized++;
      },
    });
    script.pushError(403, 'forbidden');

    await expect(client.listDocuments()).rejects.toBeInstanceOf(RelayError);
    expect(unauthorized).toBe(0);
  });
});

describe('isTransientAuthFailure (JP-396)', () => {
  it('matches the relay cold-start JWKS strings', () => {
    expect(isTransientAuthFailure('invalid token: jwks unavailable (fail-open grace expired)')).toBe(true);
    expect(isTransientAuthFailure('JWKS UNAVAILABLE')).toBe(true);
    expect(isTransientAuthFailure('fail-open grace expired')).toBe(true);
  });

  it('does not match genuine token rejections', () => {
    expect(isTransientAuthFailure('invalid token: ExpiredSignature')).toBe(false);
    expect(isTransientAuthFailure('invalid token: InvalidSignature')).toBe(false);
    expect(isTransientAuthFailure('forbidden')).toBe(false);
    expect(isTransientAuthFailure('workspace mismatch')).toBe(false);
  });
});
