/**
 * ProsePreview — the read-only prose surface shown for a relay document while
 * its collaboration engine comes up. It must resolve embedded `blob://` images
 * to object URLs just like the editable surfaces; before JP-363 it didn't, so
 * prose images flashed broken during a sign-in / document-switch transition and
 * only healed once the editable editor mounted.
 *
 * This is the automated repro: on the pre-fix code the rendered <img> keeps its
 * `blob://` src; after the fix it resolves to the (mocked) object URL.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { blobStorage } from '../storage/BlobStorage';
import { registerBlobDownloader, resetBlobCache } from '../storage/blobResolver';
import { ProsePreview } from './ProsePreview';

const HASH = 'c'.repeat(64);

function pngBlob(): Blob {
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
}

describe('ProsePreview blob image resolution (JP-363)', () => {
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

  it('resolves an embedded blob:// image to an object URL', async () => {
    loadBlobSpy = vi.spyOn(blobStorage, 'loadBlob').mockResolvedValue(pngBlob());

    const { container } = render(
      <ProsePreview html={`<p>caption</p><img src="blob://${HASH}">`} />,
    );

    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      expect(img!.getAttribute('src')).toBe('blob:mock-0');
    });

    expect(loadBlobSpy).toHaveBeenCalledWith(HASH);
  });
});
