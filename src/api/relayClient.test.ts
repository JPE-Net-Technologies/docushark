import { describe, it, expect, beforeEach } from 'vitest';
import { RelayClient, RelayError, VersionConflictError } from './relayClient';

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

  describe('auth', () => {
    it('register POSTs body and returns user', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', fetchImpl: script.fetch });
      script.pushJson(
        {
          user: {
            id: 'u-1',
            username: 'alice',
            displayName: 'Alice',
            role: 'admin',
            createdAt: 1000,
          },
        },
        201,
      );

      const result = await client.register({
        username: 'alice',
        password: 'correct-horse',
        displayName: 'Alice',
      });

      expect(result.user.username).toBe('alice');
      const call = script.calls[0]!;
      expect(call.method).toBe('POST');
      expect(call.url).toBe('http://r/api/auth/register');
      expect(JSON.parse(call.body!)).toEqual({
        username: 'alice',
        password: 'correct-horse',
        displayName: 'Alice',
      });
      expect(call.headers['authorization']).toBeUndefined();
    });

    it('login stores the token for subsequent calls', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', fetchImpl: script.fetch });
      expect(client.getToken()).toBeUndefined();

      script.pushJson({
        token: 'JWT-XYZ',
        expiresAt: 9999,
        user: { id: 'u-1', username: 'alice', displayName: 'Alice', role: 'admin', createdAt: 1 },
      });
      await client.login({ username: 'alice', password: 'pw' });

      expect(client.getToken()).toBe('JWT-XYZ');

      // Subsequent authed call should carry the token.
      script.pushJson({ documents: [] });
      await client.listDocuments();
      expect(script.calls[1]?.headers['authorization']).toBe('Bearer JWT-XYZ');
    });

    it('setToken(undefined) clears the bearer', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      client.setToken(undefined);
      script.pushJson({ documents: [] });
      await client.listDocuments();
      expect(script.calls[0]?.headers['authorization']).toBeUndefined();
    });

    it('throws RelayError with parsed server message on bad credentials', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', fetchImpl: script.fetch });
      script.pushError(401, 'invalid username or password');
      await expect(client.login({ username: 'alice', password: 'WRONG' })).rejects.toMatchObject({
        name: 'RelayError',
        status: 401,
        message: 'invalid username or password',
      });
    });

    it('changePassword POSTs current+new with Bearer', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushJson({ success: true });
      await client.changePassword({
        currentPassword: 'old',
        newPassword: 'new-password',
      });
      const call = script.calls[0]!;
      expect(call.method).toBe('POST');
      expect(call.url).toBe('http://r/api/auth/password');
      expect(call.headers['authorization']).toBe('Bearer T');
      expect(JSON.parse(call.body!)).toEqual({
        currentPassword: 'old',
        newPassword: 'new-password',
      });
    });

    it('changePassword surfaces 401 from wrong current password', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushError(401, 'invalid current password');
      await expect(
        client.changePassword({ currentPassword: 'WRONG', newPassword: 'new-password' }),
      ).rejects.toMatchObject({
        name: 'RelayError',
        status: 401,
        message: 'invalid current password',
      });
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

    it('downloadBlob returns Uint8Array', async () => {
      const client = new RelayClient({ baseUrl: 'http://r', token: 'T', fetchImpl: script.fetch });
      script.pushBinary(new Uint8Array([42, 43, 44]));
      const data = await client.downloadBlob('abc123');
      expect(Array.from(data)).toEqual([42, 43, 44]);
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

    it('does NOT fire onUnauthorized when login itself returns 401', async () => {
      let fired = 0;
      const client = new RelayClient({
        baseUrl: 'http://r',
        fetchImpl: script.fetch,
        onUnauthorized: () => fired++,
      });
      script.pushError(401, 'invalid credentials');
      await expect(
        client.login({ username: 'a', password: 'b' }),
      ).rejects.toBeInstanceOf(RelayError);
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
        await client.me();
        throw new Error('should have thrown');
      } catch (err) {
        const re = err as RelayError;
        expect(re.status).toBe(404);
        expect(re.message).toBe('Not Found');
      }
    });
  });
});
