/**
 * Blob-reference extraction across a document's rich-text + shape data.
 *
 * Both extractors are used by the garbage-collector path (persistenceStore)
 * and the storage-management UIs (StorageManager, StorageSettings) to
 * compute the live set of blob references for orphan detection.
 *
 * NOTE: For the relay sync path, `collectBlobReferences` in AssetBundler.ts is
 * the canonical single-pass extractor (rich-text `src` + FileShape `blobRef` +
 * `doc.blobReferences`). These split helpers stay scoped to the local-storage
 * GC surface; don't reach for them on the relay path.
 */

import type { JSONContent } from '@tiptap/core';
import type { Page } from '../types/Document';
import type { RichTextContent } from '../types/RichText';
import type { Shape, FileShape } from '../shapes/Shape';

/**
 * Extract blob IDs from Tiptap rich text content. Looks for `blob://`
 * URLs in image nodes anywhere in the document tree.
 */
export function extractRichTextBlobIds(richTextContent: RichTextContent | undefined): string[] {
  const blobIds: string[] = [];

  function traverse(node: JSONContent | undefined): void {
    if (!node) return;

    if (node.type === 'image' && typeof node.attrs?.['src'] === 'string') {
      const src = node.attrs['src'];
      if (src.startsWith('blob://')) {
        blobIds.push(src.slice('blob://'.length));
      }
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        traverse(child);
      }
    }
  }

  if (richTextContent?.content) {
    traverse(richTextContent.content);
  }

  return blobIds;
}

/**
 * Extract blob IDs from shape data — scans every `FileShape`'s `blobRef`
 * across all pages in a document.
 */
export function extractShapeBlobIds(pages: Record<string, Page>): string[] {
  const blobIds: string[] = [];
  for (const page of Object.values(pages)) {
    const shapes: Record<string, Shape> | undefined = page?.shapes;
    if (!shapes) continue;
    for (const shape of Object.values(shapes)) {
      if (shape.type === 'file') {
        const fileShape = shape as FileShape;
        if (fileShape.blobRef) {
          blobIds.push(fileShape.blobRef);
        }
      }
    }
  }
  return blobIds;
}
