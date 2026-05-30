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
    it('sends the blob bytes to the transport', async () => {
      const transport = makeTransport();
      const svc = new BlobSyncService({ transport, ...fast });
      await svc.uploadBlob('abc', new Blob([new Uint8Array([9, 8, 7])]));
      const [hash, data] = (transport.uploadBlob as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(hash).toBe('abc');
      expect(Array.from(data as Uint8Array)).toEqual([9, 8, 7]);
    });

    it('propagates a hash-mismatch (4xx) without retrying', async () => {
      const uploadBlob = vi.fn(async () => {
        throw httpError(400, 'Hash mismatch');
      });
      const transport = makeTransport({ uploadBlob });
      const svc = new BlobSyncService({ transport, ...fast });
      await expect(svc.uploadBlob('abc', new Blob(['x']))).rejects.toThrow('Hash mismatch');
      expect(uploadBlob).toHaveBeenCalledTimes(1);
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
      const uploadBlob = vi.fn(async () => {});
      const svc = new BlobSyncService({
        transport: makeTransport({ blobExists, uploadBlob }),
        blobStorage,
        ...fast,
      });

      const result = await svc.ensureBlobsUploaded(['present', 'missing']);

      expect(result.total).toBe(2);
      expect(result.success).toBe(2);
      // Only the missing blob was actually sent; the present one was skipped.
      expect(result.uploaded).toBe(1);
      expect(result.failed).toBe(0);
      expect(uploadBlob).toHaveBeenCalledTimes(1);
      expect((uploadBlob as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('missing');
    });

    it('records a failure when a referenced blob is absent locally', async () => {
      const { mock: blobStorage } = makeBlobStorage(); // empty
      const svc = new BlobSyncService({
        transport: makeTransport({ blobExists: vi.fn(async () => false) }),
        blobStorage,
        ...fast,
      });

      const result = await svc.ensureBlobsUploaded(['gone']);

      expect(result.failed).toBe(1);
      expect(result.errors.get('gone')).toMatch(/local storage/);
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
      const uploadBlob = vi.fn(async () => {
        throw httpError(400);
      });
      const svc = new BlobSyncService({ transport: makeTransport({ uploadBlob }), ...fast });

      await expect(svc.uploadBlob('abc', new Blob(['x']))).rejects.toThrow();
      expect(uploadBlob).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry a 504 client-timeout — fails fast (JP-127)', async () => {
      // relayClient surfaces its AbortController upload timeout as RelayError(504).
      // Re-sending a large body 5× just multiplies a slow upload, so the service
      // must fail fast and let the save layer queue one clean replay instead.
      const uploadBlob = vi.fn(async () => {
        throw httpError(504, 'Request timed out after 600000ms');
      });
      const svc = new BlobSyncService({ transport: makeTransport({ uploadBlob }), ...fast });

      await expect(svc.uploadBlob('abc', new Blob(['x']))).rejects.toThrow();
      expect(uploadBlob).toHaveBeenCalledTimes(1);
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
