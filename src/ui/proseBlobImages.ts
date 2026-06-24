/**
 * Resolve `blob://<hash>` rich-text images inside an editor DOM subtree to
 * directly-loadable object URLs.
 *
 * Shared by both prose editors (the local `TiptapEditor` and the
 * `CollaborativeProseEditor`) and the local content-load swap — a single
 * implementation so the two editors can't drift on how embedded images render.
 *
 * Resolution goes through the shared `blobResolver` (JP-129): cached object URL
 * → local IndexedDB → download from the relay/R2 on a miss, so images embedded
 * on another device render here too. Already-loadable `data:`/`http(s):` srcs
 * are returned unchanged; a true miss shows an inline placeholder.
 */

import { resolveBlobUrl } from '../storage/blobResolver';

export async function resolveBlobImagesIn(dom: HTMLElement): Promise<void> {
  const images = dom.querySelectorAll('img[src^="blob://"]');
  for (const el of Array.from(images)) {
    const img = el as HTMLImageElement;
    const blobUrl = img.getAttribute('src');
    if (!blobUrl) continue;

    const objectUrl = await resolveBlobUrl(blobUrl);
    if (objectUrl && objectUrl !== blobUrl) {
      img.setAttribute('src', objectUrl);
      // A blob that previously missed (e.g. resolved mid mode-transition) and is
      // now available: clear the placeholder so the healed image renders clean
      // instead of keeping a stale dashed border (JP-363).
      if (img.hasAttribute('data-blob-missing')) {
        img.removeAttribute('data-blob-missing');
        img.removeAttribute('alt');
        img.style.border = '';
        img.style.padding = '';
      }
    } else if (!objectUrl) {
      // Show a placeholder for a blob we genuinely can't resolve. Marked so a
      // later successful resolve (the self-heal path) can clear it.
      img.setAttribute('data-blob-missing', '');
      img.setAttribute('alt', '(Image not found)');
      img.style.border = '2px dashed var(--border-color)';
      img.style.padding = '8px';
    }
  }
}
