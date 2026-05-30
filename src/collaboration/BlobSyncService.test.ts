/**
 * BlobSyncService Tests
 *
 * Exercises the orchestration over an injected blob transport (the same
 * shape the connected RelayClient satisfies). No fetch/token mocking — the
 * service no longer owns transport or auth.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BlobSyncService,
  type BlobTransport,
  type BlobUploadMint,
  type BlobSyncProgress,
} from './BlobSyncService';
import type { BlobStorage } from '../storage/BlobStorage';

// jsdom's Blob has no arrayBuffer() (real browsers + Tauri webview do).
// Polyfill via FileReader so the service's Blob→bytes read works under test.
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as ArrayBuffer);
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(this);
    });
  };
}

/** A RelayError-shaped failure: carries a numeric `status` like the real client. */
function httpError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status });
}

/** Minimal in-memory BlobStorage stand-in (only the methods the service uses). */
function makeBlobStorage(seed: Record<string, Blob> = {}): {
  store: Map<string, Blob>;
  mock: BlobStorage;
} {
  const store = new Map<string, Blob>(Object.entries(seed));
  const mock = {
    loadBlob: vi.fn(async (id: string) => store.get(id) ?? null),
    saveBlob: vi.fn(async (blob: Blob, name: string) => {
      store.set(name, blob);
      return name;
    }),
  } as unknown as BlobStorage;
  return { store, mock };
}

function makeTransport(overrides: Partial<BlobTransport> = {}): BlobTransport {
  return {
    blobExists: vi.fn(async () => false),
    uploadBlob: vi.fn(async () => {}),
    downloadBlob: vi.fn(async () => new Uint8Array([1, 2, 3])),
    // Default to the presigned (s3) path; tests override for proxy/exists.
    mintBlobPutUrl: vi.fn(
      async (): Promise<BlobUploadMint> => ({
        kind: 'presigned',
        url: 'https://r2.example/put',
        headers: { 'content-type': 'application/octet-stream' },
        expiresAt: 0,
        key: 'ws/default/ab/cd/hash',
      }),
    ),
    putBlobToUrl: vi.fn(async () => {}),
    finalizeBlob: vi.fn(async () => {}),
    ...overrides,
  };
}

const fast = { maxRetries: 3, initialRetryDelay: 1, maxRetryDelay: 5 } as const;

describe('BlobSyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkBlobExists', () => {
    it('delegates to the transport', async () => {
      const transport = makeTransport({ blobExists: vi.fn(async () => true) });
      const svc = new BlobSyncService({ transport, ...fast });
      expect(await svc.checkBlobExists('abc')).toBe(true);
      expect(transport.blobExists).toHaveBeenCalledWith('abc');
    });
  });

  describe('uploadBlob', () => {
    it('mints a presigned URL, streams the blob straight to it, then finalizes', async () => {
      const transport = makeTransport();
      const svc = new BlobSyncService({ transport, ...fast });
      const blob = new Blob([new Uint8Array([9, 8, 7])]);
      await svc.uploadBlob('abc', blob);

      expect(transport.mintBlobPutUrl).toHaveBeenCalledWith('abc', {
        size: blob.size,
        mimeType: 'application/octet-stream',
      });
      const putCall = (transport.putBlobToUrl as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(putCall[0]).toBe('https://r2.example/put');
      // The Blob itself is streamed — not copied into a Uint8Array/ArrayBuffer.
      expect(putCall[2]).toBe(blob);
      expect(transport.finalizeBlob).toHaveBeenCalledWith('abc', {
        mimeType: 'application/octet-stream',
      });
      // The relay-proxied byte path is not used when presigning.
      expect(transport.uploadBlob).not.toHaveBeenCalled();
    });

    it('skips upload + finalize when the workspace already has the blob', async () => {
      const transport = makeTransport({
        mintBlobPutUrl: vi.fn(async (): Promise<BlobUploadMint> => ({ kind: 'exists' })),
      });
      const svc = new BlobSyncService({ transport, ...fast });
      await svc.uploadBlob('abc', new Blob(['x']));
      expect(transport.putBlobToUrl).not.toHaveBeenCalled();
      expect(transport.finalizeBlob).not.toHaveBeenCalled();
    });

    it('falls back to the proxy uploadBlob when the relay is filesystem-backed', async () => {
      const transport = makeTransport({
        mintBlobPutUrl: vi.fn(async (): Promise<BlobUploadMint> => ({ kind: 'unsupported' })),
      });
      const svc = new BlobSyncService({ transport, ...fast });
      await svc.uploadBlob('abc', new Blob([new Uint8Array([9, 8, 7])]));
      const [hash, data] = (transport.uploadBlob as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(hash).toBe('abc');
      expect(Array.from(data as Uint8Array)).toEqual([9, 8, 7]);
      expect(transport.putBlobToUrl).not.toHaveBeenCalled();
    });

    it('re-mints once when the presigned PUT 403s mid-flight', async () => {
      let puts = 0;
      const putBlobToUrl = vi.fn(async () => {
        puts += 1;
        if (puts === 1) throw httpError(403, 'expired');
      });
      const transport = makeTransport({ putBlobToUrl });
      const svc = new BlobSyncService({ transport, ...fast });
      await svc.uploadBlob('abc', new Blob(['x']));
      expect(transport.mintBlobPutUrl).toHaveBeenCalledTimes(2); // re-minted once
      expect(putBlobToUrl).toHaveBeenCalledTimes(2);
      expect(transport.finalizeBlob).toHaveBeenCalledTimes(1);
    });

    it('propagates a non-retryable finalize error (4xx) without retrying', async () => {
      const finalizeBlob = vi.fn(async () => {
        throw httpError(400, 'bad finalize');
      });
      const transport = makeTransport({ finalizeBlob });
      const svc = new BlobSyncService({ transport, ...fast });
      await expect(svc.uploadBlob('abc', new Blob(['x']))).rejects.toThrow('bad finalize');
      expect(finalizeBlob).toHaveBeenCalledTimes(1);
    });

    it('does not retry a 507 (quota) on finalize', async () => {
      const finalizeBlob = vi.fn(async () => {
        throw httpError(507, 'storage quota exceeded');
      });
      const transport = makeTransport({ finalizeBlob });
      const svc = new BlobSyncService({ transport, ...fast });
      await expect(svc.uploadBlob('abc', new Blob(['x']))).rejects.toThrow('storage quota exceeded');
      expect(finalizeBlob).toHaveBeenCalledTimes(1);
    });
  });

  describe('downloadBlob', () => {
    it('returns a Blob and sniffs PNG bytes to a MIME type', async () => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const transport = makeTransport({ downloadBlob: vi.fn(async () => png) });
      const svc = new BlobSyncService({ transport, ...fast });
      const blob = await svc.downloadBlob('abc');
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('image/png');
    });

    it('returns an untyped Blob for unknown bytes', async () => {
      const transport = makeTransport({ downloadBlob: vi.fn(async () => new Uint8Array([0, 1, 2])) });
      const svc = new BlobSyncService({ transport, ...fast });
      const blob = await svc.downloadBlob('abc');
      expect(blob.type).toBe('');
    });
  });

  describe('ensureBlobsUploaded', () => {
    it('skips blobs already on the relay and uploads only the missing ones', async () => {
      const { mock: blobStorage } = makeBlobStorage({
        present: new Blob(['a']),
        missing: new Blob(['b']),
      });
      const blobExists = vi.fn(async (hash: string) => hash === 'present');
      const transport = makeTransport({ blobExists });
      const svc = new BlobSyncService({ transport, blobStorage, ...fast });

      const result = await svc.ensureBlobsUploaded(['present', 'missing']);

      expect(result.total).toBe(2);
      expect(result.success).toBe(2);
      // Only the missing blob was actually sent (presigned path); the present
      // one was skipped by the HEAD-gate.
      expect(result.uploaded).toBe(1);
      expect(result.failed).toBe(0);
      expect(transport.finalizeBlob).toHaveBeenCalledTimes(1);
      expect((transport.finalizeBlob as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('missing');
    });

    it('skips (does not fail) a referenced blob absent locally and not on the relay', async () => {
      const { mock: blobStorage } = makeBlobStorage(); // empty
      const transport = makeTransport({ blobExists: vi.fn(async () => false) });
      const svc = new BlobSyncService({ transport, blobStorage, ...fast });

      const result = await svc.ensureBlobsUploaded(['gone']);

      // A dangling reference must not fail the save — it's skipped, never uploaded.
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.uploaded).toBe(0);
      expect(transport.mintBlobPutUrl).not.toHaveBeenCalled();
    });
  });

  describe('downloadMissingBlobs', () => {
    it('downloads and persists blobs missing locally; skips present ones', async () => {
      const { store, mock: blobStorage } = makeBlobStorage({ here: new Blob(['x']) });
      const downloadBlob = vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
      const svc = new BlobSyncService({
        transport: makeTransport({ downloadBlob }),
        blobStorage,
        ...fast,
      });

      const result = await svc.downloadMissingBlobs(['here', 'fetchme']);

      expect(result.success).toBe(2);
      expect(downloadBlob).toHaveBeenCalledTimes(1);
      expect(downloadBlob).toHaveBeenCalledWith('fetchme');
      expect(store.has('fetchme')).toBe(true);
    });
  });

  describe('progress callback', () => {
    it('reports checking then uploading phases', async () => {
      const phases: BlobSyncProgress['phase'][] = [];
      const { mock: blobStorage } = makeBlobStorage({ h1: new Blob(['x']) });
      const svc = new BlobSyncService({
        transport: makeTransport({ blobExists: vi.fn(async () => false) }),
        blobStorage,
        onProgress: (p) => phases.push(p.phase),
        ...fast,
      });

      await svc.ensureBlobsUploaded(['h1']);

      expect(phases).toContain('checking');
      expect(phases).toContain('uploading');
    });

    it('forwards a per-call onProgress with file counts (JP-126)', async () => {
      const events: BlobSyncProgress[] = [];
      const { mock: blobStorage } = makeBlobStorage({ h1: new Blob(['a']), h2: new Blob(['b']) });
      const svc = new BlobSyncService({
        transport: makeTransport({ blobExists: vi.fn(async () => false) }),
        blobStorage,
        ...fast,
      });

      await svc.ensureBlobsUploaded(['h1', 'h2'], (p) => events.push(p));

      const uploading = events.filter((e) => e.phase === 'uploading');
      expect(uploading.length).toBeGreaterThan(0);
      expect(uploading[uploading.length - 1]).toMatchObject({ current: 2, total: 2 });
    });
  });

  describe('retry logic', () => {
    it('retries on a 5xx then succeeds', async () => {
      let calls = 0;
      const downloadBlob = vi.fn(async () => {
        calls++;
        if (calls === 1) throw httpError(500);
        return new Uint8Array([1]);
      });
      const svc = new BlobSyncService({ transport: makeTransport({ downloadBlob }), ...fast });

      const blob = await svc.downloadBlob('abc');
      expect(blob).toBeInstanceOf(Blob);
      expect(downloadBlob).toHaveBeenCalledTimes(2);
    });

    it('does not retry a 4xx', async () => {
      const putBlobToUrl = vi.fn(async () => {
        throw httpError(400);
      });
      const svc = new BlobSyncService({ transport: makeTransport({ putBlobToUrl }), ...fast });

      await expect(svc.uploadBlob('abc', new Blob(['x']))).rejects.toThrow();
      expect(putBlobToUrl).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry a 504 client-timeout — fails fast (JP-127)', async () => {
      // The big direct-to-R2 PUT surfaces relayClient's AbortController upload
      // timeout as RelayError(504). Re-sending a large body 5× just multiplies a
      // slow upload, so the service fails fast and lets the save layer queue one
      // clean replay instead.
      const putBlobToUrl = vi.fn(async () => {
        throw httpError(504, 'Request timed out after 600000ms');
      });
      const svc = new BlobSyncService({ transport: makeTransport({ putBlobToUrl }), ...fast });

      await expect(svc.uploadBlob('abc', new Blob(['x']))).rejects.toThrow();
      expect(putBlobToUrl).toHaveBeenCalledTimes(1);
    });

    it('retries network errors (no status) up to maxRetries then throws', async () => {
      const downloadBlob = vi.fn(async () => {
        throw new Error('network down');
      });
      const svc = new BlobSyncService({
        transport: makeTransport({ downloadBlob }),
        maxRetries: 2,
        initialRetryDelay: 1,
        maxRetryDelay: 5,
      });

      await expect(svc.downloadBlob('abc')).rejects.toThrow('network down');
      // initial attempt + 2 retries
      expect(downloadBlob).toHaveBeenCalledTimes(3);
    });
  });
});
