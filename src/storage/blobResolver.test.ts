import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { blobStorage } from './BlobStorage';
import {
  resolveBlobObjectUrl,
  resolveBlobUrl,
  peekBlobObjectUrl,
  requestBlobThumbnail,
  registerBlobDownloader,
  resetBlobCache,
  setMaxTransientBytes,
  isBlobMissing,
  blobHashFromRef,
  onBlobLoad,
  sniffMimeFromBytes,
} from './blobResolver';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function pngBlob(bytes = 4): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'image/png' });
}

describe('sniffMimeFromBytes', () => {
  const bytesOf = (s: string) => new TextEncoder().encode(s);

  it('detects SVG so an untyped object URL renders (browsers do not sniff SVG)', () => {
    expect(sniffMimeFromBytes(bytesOf('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml');
    expect(sniffMimeFromBytes(bytesOf('<?xml version="1.0"?>\n<svg></svg>'))).toBe('image/svg+xml');
    expect(sniffMimeFromBytes(bytesOf('  \n  <SVG></SVG>'))).toBe('image/svg+xml'); // leading ws + case
    expect(sniffMimeFromBytes(bytesOf('﻿<svg></svg>'))).toBe('image/svg+xml'); // BOM
  });

  it('detects common binary types by magic number', () => {
    expect(sniffMimeFromBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    expect(sniffMimeFromBytes(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(sniffMimeFromBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe('application/pdf');
  });

  it('returns null for unrecognized / empty content (blob left as-is)', () => {
    expect(sniffMimeFromBytes(bytesOf('just some text'))).toBeNull();
    expect(sniffMimeFromBytes(new Uint8Array(0))).toBeNull();
  });
});

describe('blobResolver', () => {
  let loadBlobSpy: MockInstance<[id: string], Promise<Blob | null>>;
  let urlCounter: number;

  beforeEach(() => {
    urlCounter = 0;
    // jsdom lacks createObjectURL/revokeObjectURL — mint a unique URL per call.
    globalThis.URL.createObjectURL = vi.fn(() => `blob:mock-${urlCounter++}`);
    globalThis.URL.revokeObjectURL = vi.fn();
    registerBlobDownloader(null);
    resetBlobCache();
    setMaxTransientBytes(100 * 1024 * 1024);
  });

  afterEach(() => {
    loadBlobSpy?.mockRestore();
    registerBlobDownloader(null);
    resetBlobCache();
  });

  describe('blobHashFromRef', () => {
    it('strips the blob:// scheme and passes through other URLs', () => {
      expect(blobHashFromRef(`blob://${HASH_A}`)).toBe(HASH_A);
      expect(blobHashFromRef('https://x/y.png')).toBeNull();
      expect(blobHashFromRef('data:image/png;base64,AAAA')).toBeNull();
      expect(blobHashFromRef(undefined)).toBeNull();
    });
  });

  describe('resolveBlobObjectUrl', () => {
    it('resolves from local storage and caches the object URL', async () => {
      loadBlobSpy = vi.spyOn(blobStorage, 'loadBlob').mockResolvedValue(pngBlob());

      const url = await resolveBlobObjectUrl(HASH_A);

      expect(url).toBe('blob:mock-0');
      expect(loadBlobSpy).toHaveBeenCalledWith(HASH_A);
      expect(isBlobMissing(HASH_A)).toBe(false);
      // Synchronous peek now hits the cache, and a second resolve doesn't re-load.
      expect(peekBlobObjectUrl(HASH_A)).toBe('blob:mock-0');
      await resolveBlobObjectUrl(HASH_A);
      expect(loadBlobSpy).toHaveBeenCalledTimes(1);
    });

    it('downloads on a local miss via the registered downloader, then re-loads', async () => {
      loadBlobSpy = vi
        .spyOn(blobStorage, 'loadBlob')
        .mockResolvedValueOnce(null) // first lookup: not local
        .mockResolvedValue(pngBlob()); // after download: present
      const downloader = vi.fn(async () => true);
      registerBlobDownloader(downloader);

      const url = await resolveBlobObjectUrl(HASH_A);

      expect(downloader).toHaveBeenCalledWith(HASH_A);
      expect(loadBlobSpy).toHaveBeenCalledTimes(2);
      expect(url).toBe('blob:mock-0');
      expect(isBlobMissing(HASH_A)).toBe(false);
    });

    it('returns null and marks missing when not local and not downloadable', async () => {
      loadBlobSpy = vi.spyOn(blobStorage, 'loadBlob').mockResolvedValue(null);
      const downloader = vi.fn(async () => false);
      registerBlobDownloader(downloader);

      const url = await resolveBlobObjectUrl(HASH_A);

      expect(url).toBeNull();
      expect(downloader).toHaveBeenCalledWith(HASH_A);
      expect(isBlobMissing(HASH_A)).toBe(true);
    });

    it('does not attempt a download when allowDownload is false', async () => {
      loadBlobSpy = vi.spyOn(blobStorage, 'loadBlob').mockResolvedValue(null);
      const downloader = vi.fn(async () => true);
      registerBlobDownloader(downloader);

      const url = await resolveBlobObjectUrl(HASH_A, { allowDownload: false });

      expect(url).toBeNull();
      expect(downloader).not.toHaveBeenCalled();
      expect(isBlobMissing(HASH_A)).toBe(true);
    });

    it('dedupes concurrent resolves of the same hash', async () => {
      loadBlobSpy = vi.spyOn(blobStorage, 'loadBlob').mockResolvedValue(pngBlob());

      const [a, b] = await Promise.all([
        resolveBlobObjectUrl(HASH_A),
        resolveBlobObjectUrl(HASH_A),
      ]);

      expect(a).toBe(b);
      expect(loadBlobSpy).toHaveBeenCalledTimes(1);
    });

    it('notifies load listeners on completion', async () => {
      loadBlobSpy = vi.spyOn(blobStorage, 'loadBlob').mockResolvedValue(pngBlob());
      const cb = vi.fn();
      const unsub = onBlobLoad(cb);

      await resolveBlobObjectUrl(HASH_A);

      expect(cb).toHaveBeenCalled();
      unsub();
    });
  });

  describe('resolveBlobUrl (img-style source)', () => {
    it('passes through directly-loadable URLs unchanged', async () => {
      loadBlobSpy = vi.spyOn(blobStorage, 'loadBlob');
      expect(await resolveBlobUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
      expect(await resolveBlobUrl('https://x/y.png')).toBe('https://x/y.png');
      expect(loadBlobSpy).not.toHaveBeenCalled();
    });

    it('resolves a blob:// ref to an object URL', async () => {
      loadBlobSpy = vi.spyOn(blobStorage, 'loadBlob').mockResolvedValue(pngBlob());
      expect(await resolveBlobUrl(`blob://${HASH_A}`)).toBe('blob:mock-0');
    });
  });

  describe('LRU eviction (transient entries)', () => {
    it('evicts and revokes the least-recently-used transient URL over budget', async () => {
      loadBlobSpy = vi.spyOn(blobStorage, 'loadBlob').mockResolvedValue(pngBlob(10));
      setMaxTransientBytes(15); // room for one 10-byte blob, not two

      await resolveBlobObjectUrl(HASH_A); // blob:mock-0
      await resolveBlobObjectUrl(HASH_B); // forces eviction of A

      expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-0');
      expect(peekBlobObjectUrl(HASH_A)).toBeUndefined();
      expect(peekBlobObjectUrl(HASH_B)).toBe('blob:mock-1');
    });

    it('never evicts a pinned (thumbnail/rich-text) URL under budget pressure', async () => {
      loadBlobSpy = vi.spyOn(blobStorage, 'loadBlob').mockResolvedValue(pngBlob(10));
      setMaxTransientBytes(5);

      // Pin A (e.g. a thumbnail), then resolve a transient B that exceeds budget.
      const pinnedUrl = await resolveBlobObjectUrl(HASH_A, { pinned: true });
      await resolveBlobObjectUrl(HASH_B); // transient, over budget — must not evict A

      expect(pinnedUrl).not.toBeNull();
      expect(peekBlobObjectUrl(HASH_A)).toBe(pinnedUrl); // survives
      expect(peekBlobObjectUrl(HASH_B)).toBeDefined();
    });
  });

  describe('requestBlobThumbnail', () => {
    it('resolves in the background without downloading (canvas path)', async () => {
      loadBlobSpy = vi.spyOn(blobStorage, 'loadBlob').mockResolvedValue(null);
      const downloader = vi.fn(async () => true);
      registerBlobDownloader(downloader);

      requestBlobThumbnail(HASH_A);
      // Fire-and-forget: drain the resolve's microtask chain via a macrotask.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(downloader).not.toHaveBeenCalled();
      expect(isBlobMissing(HASH_A)).toBe(true);
    });
  });

  describe('resetBlobCache', () => {
    it('revokes all URLs and clears availability', async () => {
      loadBlobSpy = vi.spyOn(blobStorage, 'loadBlob').mockResolvedValue(pngBlob());
      await resolveBlobObjectUrl(HASH_A);
      expect(peekBlobObjectUrl(HASH_A)).toBe('blob:mock-0');

      resetBlobCache();

      expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-0');
      expect(peekBlobObjectUrl(HASH_A)).toBeUndefined();
      expect(isBlobMissing(HASH_A)).toBeUndefined();
    });
  });
});
