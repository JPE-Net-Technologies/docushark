/**
 * resolveBlobImagesIn — resolves `blob://<hash>` rich-text images in an editor
 * DOM subtree to object URLs, and shows a *non-sticky* placeholder on a genuine
 * miss so the self-heal path (resolve succeeds on a later pass, e.g. after a
 * local↔collab mode flip) renders the healed image clean (JP-363).
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { blobStorage } from '../storage/BlobStorage';
import { registerBlobDownloader, resetBlobCache } from '../storage/blobResolver';
import { resolveBlobImagesIn } from './proseBlobImages';

const HASH = 'a'.repeat(64);

function pngBlob(): Blob {
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
}

function subtreeWithBlobImage(): { dom: HTMLElement; img: HTMLImageElement } {
  const dom = document.createElement('div');
  dom.innerHTML = `<p>before</p><img src="blob://${HASH}"><p>after</p>`;
  return { dom, img: dom.querySelector('img')! };
}

describe('resolveBlobImagesIn', () => {
  let loadBlobSpy: MockInstance<[id: string], Promise<Blob | null>>;
  let urlCounter: number;

  beforeEach(() => {
    urlCounter = 0;
    globalThis.URL.createObjectURL = vi.fn(() => `blob:mock-${urlCounter++}`);
    globalThis.URL.revokeObjectURL = vi.fn();
    registerBlobDownloader(null);
    resetBlobCache();
  });

  afterEach(() => {
    loadBlobSpy?.mockRestore();
    registerBlobDownloader(null);
    resetBlobCache();
  });

  it('resolves a blob:// image to an object URL', async () => {
    loadBlobSpy = vi.spyOn(blobStorage, 'loadBlob').mockResolvedValue(pngBlob());
    const { dom, img } = subtreeWithBlobImage();

    await resolveBlobImagesIn(dom);

    expect(img.getAttribute('src')).toBe('blob:mock-0');
    expect(img.hasAttribute('data-blob-missing')).toBe(false);
  });

  it('shows a marked placeholder for a blob that genuinely cannot resolve', async () => {
    loadBlobSpy = vi.spyOn(blobStorage, 'loadBlob').mockResolvedValue(null);
    const { dom, img } = subtreeWithBlobImage();

    await resolveBlobImagesIn(dom);

    // src is left as the blob:// ref so a later pass can retry it.
    expect(img.getAttribute('src')).toBe(`blob://${HASH}`);
    expect(img.hasAttribute('data-blob-missing')).toBe(true);
    expect(img.getAttribute('alt')).toBe('(Image not found)');
    expect(img.style.border).toContain('dashed');
  });

  it('clears the placeholder when a later pass resolves the blob (self-heal)', async () => {
    // First pass misses (e.g. mid mode-transition), second pass succeeds — the
    // JP-363 flip-then-heal sequence.
    loadBlobSpy = vi
      .spyOn(blobStorage, 'loadBlob')
      .mockResolvedValueOnce(null)
      .mockResolvedValue(pngBlob());
    const { dom, img } = subtreeWithBlobImage();

    await resolveBlobImagesIn(dom);
    expect(img.hasAttribute('data-blob-missing')).toBe(true);

    await resolveBlobImagesIn(dom);

    expect(img.getAttribute('src')).toBe('blob:mock-0');
    expect(img.hasAttribute('data-blob-missing')).toBe(false);
    expect(img.getAttribute('alt')).toBeNull();
    expect(img.style.border).toBe('');
    expect(img.style.padding).toBe('');
  });

  it('leaves directly-loadable srcs untouched (only blob:// is rewritten)', async () => {
    loadBlobSpy = vi.spyOn(blobStorage, 'loadBlob');
    const dom = document.createElement('div');
    dom.innerHTML = '<img src="https://x/y.png"><img src="data:image/png;base64,AAAA">';

    await resolveBlobImagesIn(dom);

    expect(dom.querySelectorAll('img')[0]!.getAttribute('src')).toBe('https://x/y.png');
    expect(dom.querySelectorAll('img')[1]!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(loadBlobSpy).not.toHaveBeenCalled();
  });
});
