/**
 * Pasted images become document images (DSK-208).
 *
 * A pasted `<img>` used to keep whatever source it came with: a `data:` URI, a
 * website's URL, a `file:` path. It rendered, but it was never stored, so a
 * workspace document never uploaded it (the workspace upload only sends
 * `blob://` references) and a `data:` image rode inside the document itself.
 *
 * Now a paste (or a drop) carrying such images is held: a placeholder marks
 * its place, each image goes through the same pipeline as Upload image
 * (`uploadProseImage`: validate, downscale, store), and the content is then
 * inserted with the stored `blob://` sources, in one transaction. One step to
 * undo, in either editor, and nothing transient reaches collaborators. (An
 * earlier version inserted at once and switched the sources afterwards, outside
 * the undo history; in a collaborative document y-prosemirror couldn't then
 * undo the paste.)
 *
 * An image whose website won't share it stays linked, and the writer is told.
 * Image files on the clipboard (a screenshot, "Copy image") go the same way.
 */
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { uploadProseImage, type UploadedProseImage } from '../../ui/proseImageUpload';
import { useNotificationStore } from '../../store/notificationStore';
import {
  addPastePlaceholder,
  findPastePlaceholder,
  hasPastePlaceholder,
  removePastePlaceholder,
  pastePlaceholderKey,
} from './PastePlaceholder';

/** How many images are fetched and stored at once. */
const CONCURRENCY = 4;

/** How long a website gets to answer before its image is left linked. */
const REMOTE_TIMEOUT_MS = 8000;

/** A source the paste must store: anything but our own `blob://<hash>` references. */
export function needsStoring(src: unknown): src is string {
  return typeof src === 'string' && /^(data:image\/|blob:(?!\/\/)|https?:)/i.test(src);
}

/** The distinct image sources in pasted content that still need storing. */
export function imageSourcesIn(slice: Slice): string[] {
  const sources = new Set<string>();
  slice.content.descendants((node) => {
    if (node.type.name === 'image' && needsStoring(node.attrs['src'])) sources.add(node.attrs['src']);
    return true;
  });
  return [...sources];
}

export type StoreResult = { kind: 'stored'; src: string } | { kind: 'linked' } | { kind: 'failed' };

/**
 * Fetch an image source and store it. A website that refuses (CORS, 404) or
 * doesn't answer in time leaves the image `linked`; anything else that can't
 * be stored has `failed`.
 */
export async function storeImageSource(src: string): Promise<StoreResult> {
  const remote = /^https?:/i.test(src);
  const unavailable: StoreResult = remote ? { kind: 'linked' } : { kind: 'failed' };
  let blob: Blob;
  try {
    const response = await fetch(
      src,
      remote
        ? { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) }
        : undefined,
    );
    if (!response.ok) return unavailable;
    blob = await response.blob();
  } catch {
    return unavailable;
  }
  if (!blob.type.startsWith('image/')) return unavailable;
  try {
    const stored = await uploadProseImage(new File([blob], pastedImageName(blob.type), { type: blob.type }));
    return { kind: 'stored', src: stored.src };
  } catch {
    return { kind: 'failed' };
  }
}

/** The slice with each image's source replaced by its stored one, where it has one. */
export function withStoredSources(slice: Slice, stored: ReadonlyMap<string, string>): Slice {
  const map = (fragment: Fragment): Fragment => {
    const nodes: PMNode[] = [];
    fragment.forEach((node) => {
      const next = node.type.name === 'image' ? stored.get(node.attrs['src']) : undefined;
      if (next) nodes.push(node.type.create({ ...node.attrs, src: next }, node.content, node.marks));
      else nodes.push(node.content.size > 0 ? node.copy(map(node.content)) : node);
    });
    return Fragment.fromArray(nodes);
  };
  return new Slice(map(slice.content), slice.openStart, slice.openEnd);
}

/**
 * Insert pasted or dropped content once its images are stored: at `at` (a
 * drop), or in place of the selection (a paste). `droppedImages` counts images
 * removed before the parse, for the report.
 */
export async function insertStoringImages(
  view: EditorView,
  slice: Slice,
  { at, droppedImages = 0 }: { at?: number; droppedImages?: number } = {},
): Promise<void> {
  const sources = imageSourcesIn(slice);
  const hold = holdPlace(view, at);
  const results = await mapLimit(sources, CONCURRENCY, storeImageSource);
  if (view.isDestroyed) return;

  const stored = new Map<string, string>();
  let linked = 0;
  let failed = 0;
  sources.forEach((src, i) => {
    const result = results[i]!;
    if (result.kind === 'stored') stored.set(src, result.src);
    else if (result.kind === 'linked') linked++;
    else failed++;
  });

  const tr = view.state.tr;
  const pos = releasePlace(view, tr, hold);
  if (pos !== null) {
    tr.replaceRange(pos, pos, withStoredSources(slice, stored));
    tr.setMeta('paste', true).setMeta('uiEvent', 'paste').scrollIntoView();
  }
  view.dispatch(tr);
  reportPaste({ dropped: droppedImages, linked, failed });
}

/**
 * Insert image files (a screenshot, "Copy image") in place of the selection,
 * once they're stored.
 */
export async function insertImageFiles(view: EditorView, files: readonly File[]): Promise<void> {
  const hold = holdPlace(view);
  const results = await mapLimit(files, CONCURRENCY, async (file) => {
    try {
      return await uploadProseImage(file);
    } catch {
      return null;
    }
  });
  if (view.isDestroyed) return;

  const stored = results.filter((r): r is UploadedProseImage => r !== null);
  const tr = view.state.tr;
  const pos = releasePlace(view, tr, hold);
  const imageType = view.state.schema.nodes['image'];
  if (pos !== null && imageType && stored.length > 0) {
    const nodes = stored.map((image) => imageType.create({ src: image.src, alt: image.alt }));
    tr.replaceRange(pos, pos, new Slice(Fragment.from(nodes), 0, 0)).scrollIntoView();
  }
  view.dispatch(tr);
  reportPaste({ dropped: 0, linked: 0, failed: results.length - stored.length });
}

/** Say what a paste couldn't keep. */
export function reportPaste({ dropped, linked, failed }: { dropped: number; linked: number; failed: number }): void {
  const lines: string[] = [];
  if (dropped > 0) {
    lines.push(`${images(dropped)} couldn’t be pasted because the browser can’t read ${dropped === 1 ? 'it' : 'them'}. Add ${dropped === 1 ? 'it' : 'them'} with Upload image.`);
  }
  if (linked > 0) {
    lines.push(
      linked === 1
        ? '1 image still loads from its website, which doesn’t allow copying it. Upload it to keep a copy.'
        : `${linked} images still load from their websites, which don’t allow copying them. Upload them to keep copies.`,
    );
  }
  if (failed > 0) lines.push(`${images(failed)} couldn’t be stored in the document.`);
  if (lines.length > 0) useNotificationStore.getState().warning(lines.join(' '));
}

// --- Holding the place -------------------------------------------------------

interface Hold {
  id: object;
  /** Where to insert when the editor has no placeholder plugin (the read-only preview). */
  fallback: number;
  withPlaceholder: boolean;
}

/** Clear the selection (a paste replaces it) and mark where the content will go. */
function holdPlace(view: EditorView, at?: number): Hold {
  const id = {};
  const tr = view.state.tr;
  if (at === undefined && !tr.selection.empty) tr.deleteSelection();
  const pos = at ?? tr.selection.from;
  const withPlaceholder = hasPastePlaceholder(view.state);
  if (withPlaceholder) tr.setMeta(pastePlaceholderKey, addPastePlaceholder(id, pos));
  view.dispatch(tr);
  return { id, fallback: tr.mapping.map(pos), withPlaceholder };
}

/** The held position, as edits since have moved it; null if its text was deleted. Removes the marker. */
function releasePlace(view: EditorView, tr: Transaction, hold: Hold): number | null {
  if (!hold.withPlaceholder) return Math.min(hold.fallback, view.state.doc.content.size);
  tr.setMeta(pastePlaceholderKey, removePastePlaceholder(hold.id));
  return findPastePlaceholder(view.state, hold.id);
}

// --- Helpers -----------------------------------------------------------------

function images(count: number): string {
  return count === 1 ? '1 image' : `${count} images`;
}

function pastedImageName(type: string): string {
  const extension = type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png';
  return `pasted-image.${extension}`;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
