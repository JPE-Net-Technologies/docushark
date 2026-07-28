/**
 * recentThumbnails (JP-444) — best-effort mini previews for the home screen's
 * "Continue working" cards.
 *
 * Content ladder (cheapest first, all local — never a network fetch):
 *   1. registry in-memory content (doc already loaded this session)
 *   2. localStorage body (local docs, synchronous)
 *   3. IndexedDB relay cache (offline-available workspace docs)
 * A doc whose content isn't locally available gets no thumbnail — the card
 * falls back to a stylized placeholder.
 *
 * Rendering reuses the pure `exportToSvg` shape renderer over the active
 * page's first shapes. Known limit: image/file shapes reference unresolved
 * blob:// URLs, so they render as empty frames — acceptable at card size.
 */
import type { DiagramDocument } from '../../types/Document';
import type { Shape } from '../../shapes/Shape';
import type { DocumentRecord } from '../../types/DocumentRegistry';
import { useDocumentRegistry } from '../../store/documentRegistry';
import { loadDocumentFromStorage } from '../../store/persistenceStore';
import { RelayDocumentCache } from '../../storage/RelayDocumentCache';
import { activeWorkspaceId } from '../../store/activeWorkspace';
import { exportToSvg } from '../../utils/exportUtils';

export interface RecentPreview {
  /** SVG data URI of the canvas thumbnail, or null when not renderable. */
  uri: string | null;
  /** What the doc's content looks like — picks the placeholder variant. */
  kind: 'canvas' | 'doc' | 'unknown';
}

/** The preview surface's theme — AUTO-colour shapes resolve to a contrasting
 *  ink (white on dark, black on light), so it's part of the render identity. */
export type PreviewTheme = 'light' | 'dark';

/** Z-order cap — a thumbnail needs the gist, not all 10k shapes. */
const MAX_SHAPES = 40;
/** Bounded memo keyed `id:modifiedAt` — an edit invalidates naturally. */
const MAX_CACHE = 32;
const cache = new Map<string, RecentPreview>();

async function contentFor(record: DocumentRecord): Promise<DiagramDocument | null> {
  const inMemory = useDocumentRegistry.getState().getDocumentContent(record.id);
  if (inMemory) return inMemory;
  if (record.type === 'local') return loadDocumentFromStorage(record.id);
  const ws = activeWorkspaceId();
  if (!RelayDocumentCache.has(ws, record.id)) return null;
  try {
    return await RelayDocumentCache.get(ws, record.id);
  } catch {
    return null;
  }
}

function toPreview(doc: DiagramDocument, theme: PreviewTheme): RecentPreview {
  const pageId = doc.pages[doc.activePageId] ? doc.activePageId : doc.pageOrder[0];
  const page = pageId ? doc.pages[pageId] : undefined;
  const order = (page?.shapeOrder ?? []).filter((id) => page?.shapes[id]).slice(0, MAX_SHAPES);
  if (!page || order.length === 0) {
    const hasProse = (doc.richTextPages?.pageOrder.length ?? 0) > 0 || !!doc.richTextContent;
    return { uri: null, kind: hasProse ? 'doc' : 'canvas' };
  }
  const shapes: Record<string, Shape> = {};
  for (const id of order) shapes[id] = page.shapes[id]!;
  try {
    const svg = exportToSvg(
      { shapes, shapeOrder: order, selectedIds: [] },
      {
        format: 'svg',
        scope: 'all',
        scale: 1,
        background: null,
        padding: 24,
        filename: 'thumbnail',
        // Transparent background defaults AUTO shapes to black ink — pin the
        // ink to the theme instead, so auto-coloured connectors/labels stay
        // visible on the dark preview surface.
        autoInk: theme === 'dark' ? 'white' : 'black',
      }
    );
    return {
      uri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      kind: 'canvas',
    };
  } catch {
    return { uri: null, kind: 'canvas' };
  }
}

export async function getRecentPreview(
  record: DocumentRecord,
  theme: PreviewTheme
): Promise<RecentPreview> {
  const key = `${record.id}:${record.modifiedAt}:${theme}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const doc = await contentFor(record);
  const preview: RecentPreview = doc ? toPreview(doc, theme) : { uri: null, kind: 'unknown' };
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, preview);
  return preview;
}
