/**
 * What the file viewer needs to show a file, independent of where the file
 * lives (JP-495).
 *
 * The viewer used to take a canvas `shapeId` and look the shape up itself. A
 * prose file chip has no shape, and building a second prose-only viewer is the
 * *second-renderer defect class* that produced JP-468/472/473 — so instead both
 * hosts describe their file the same way and there stays exactly one viewer.
 *
 * The viewer is not read-only: it can replace a file's contents and recover a
 * missing blob. Those are host-specific mutations, so they arrive as optional
 * callbacks rather than being reachable from the data. **Absent means the host
 * cannot do it, and the affordance is hidden** — not shown-but-broken.
 */

import { isFile, type Shape } from '../shapes/Shape';
import type { FileCategory } from '../utils/fileUtils';

/** Prefix of the `blob://<hash>` URI form used inside prose HTML. */
const BLOB_PREFIX = 'blob://';

/**
 * Reduce either reference form to the bare hash the blob store is keyed by.
 *
 * The two forms are not interchangeable and the difference is easy to miss: a
 * `FileShape` stores a **bare hash**, while a prose chip stores the
 * **`blob://<hash>` URI** (it has to — a reference inside an HTML string is only
 * discoverable by the URI grammar, JP-494). Normalizing here, at the one
 * boundary both hosts pass through, is what stops a `blob://blob://…` from ever
 * being constructed.
 *
 * **Not** the same as `blobHashFromRef` (`storage/blobResolver.ts`), which
 * returns `null` for a bare hash because it is distinguishing a `blob://` ref
 * from a directly-loadable URL. This one accepts either form and always yields a
 * hash — do not "consolidate" the two.
 */
export function toBlobHash(ref: string): string {
  let out = ref;
  // A loop, not a single strip: a value that was prefixed twice by an earlier
  // bug should still resolve rather than silently failing to load.
  while (out.startsWith(BLOB_PREFIX)) out = out.slice(BLOB_PREFIX.length);
  return out;
}

export interface FileDescriptor {
  /** Bare SHA-256 hash — always run the source through `toBlobHash`. */
  blobRef: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  /**
   * Drives viewer dispatch. Carried rather than always re-derived so a canvas
   * shape keeps using the category it stored — deriving it here instead would
   * silently change which viewer opens for any shape whose stored category and
   * mime disagree. Prose has nothing stored, so it derives with
   * `detectFileCategory` (JP-495 keeps the category out of the chip's attrs
   * precisely so it can never drift from the mime).
   */
  fileCategory: FileCategory;
  /**
   * Stable key for per-file view state (PDF reading position + bookmarks),
   * scoped to the document by `PdfViewer`. A canvas shape uses its shape id, so
   * two shapes of the same PDF keep separate positions. Prose passes the blob
   * hash instead: a chip has no durable id of its own, and "the same attachment
   * resumes where I left it" is the behaviour a reader expects anyway.
   * Optional — `PdfViewer` simply stops persisting when it is absent.
   */
  sourceId?: string | undefined;
  /** Display name override; falls back to `fileName`. */
  label?: string | undefined;
  preview?: { pageCount?: number | undefined } | undefined;
  /**
   * Swap the file's contents for `file`. Absent ⇒ the host has nowhere to write
   * the new reference, so the Replace affordance is not rendered.
   */
  onReplace?: ((file: File) => Promise<boolean>) | undefined;
  /**
   * Re-upload the bytes for a blob that has gone missing. Absent ⇒ the recovery
   * affordance is not rendered, and the viewer just reports the file missing.
   */
  onRecover?: ((file: File) => Promise<boolean>) | undefined;
}

/**
 * Describe a canvas `FileShape`. Returns null for a shape that is absent or not
 * a file, matching the old `useFileShape` contract.
 *
 * Capabilities are supplied by the caller because they need the services layer,
 * which this module deliberately does not depend on.
 */
export function describeFileShape(
  shape: Shape | undefined,
  capabilities?: Pick<FileDescriptor, 'onReplace' | 'onRecover'>,
): FileDescriptor | null {
  if (!shape || !isFile(shape)) return null;
  return {
    blobRef: toBlobHash(shape.blobRef),
    fileName: shape.fileName,
    mimeType: shape.mimeType,
    fileSize: shape.fileSize,
    fileCategory: shape.fileCategory,
    sourceId: shape.id,
    label: shape.label,
    preview: shape.preview,
    ...capabilities,
  };
}
