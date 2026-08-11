/**
 * Mirror page service (JP-415) — create, refresh, and detach prose pages that
 * mirror an external resource (Notion first). Provider-agnostic: all provider
 * logic lives in the cloud control plane; this service consumes its
 * materialized output (`proseHtml` with `blob://<sha256>` refs already
 * substituted) and writes through the editor's own CRDT rails:
 *
 *   fetch (webClient) → createPage → YjsDocument.setProse (merge-safe
 *   fragment diff) → setPageMirror (rides the JP-339 page list to peers)
 *
 * Requirements enforced here, not assumed: a LIVE collaborative workspace doc
 * (the fetch already ingested blobs into that workspace's relay, and the
 * fragment write needs the shared Y.Doc), and a loaded prose chunk (the
 * registered schema parses the HTML — guaranteed in practice, the user is in
 * the editor when adding a page).
 */

import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';

import {
  webClient,
  type ExternalResource,
  type FetchedMirrorContent,
  type ImportWarningInfo,
  type MirrorSourceRef,
} from '../api/webClient';
import { getProseSchema } from '../collaboration/proseSchema';
import { useCollaborationStore } from '../collaboration/collaborationStore';
import type { YjsDocument } from '../collaboration/YjsDocument';
import { usePersistenceStore } from '../store/persistenceStore';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import type { PageMirrorMeta } from '../types/PageMirror';
import { buildMirrorFamilyIndex, externalKey, subtreeInsertionIndex } from './mirrorFamily';

/** A mirror operation the user can understand failed — message is UI-ready. */
export class MirrorPageError extends Error {
  constructor(
    public readonly code: 'no_live_doc' | 'not_a_mirror' | 'fetch_failed',
    message: string,
  ) {
    super(message);
    this.name = 'MirrorPageError';
  }
}

export interface MirrorPageDeps {
  /** Fetch override (tests). Defaults to the control-plane client. */
  fetchResource?: (provider: string, externalId: string) => Promise<FetchedMirrorContent>;
  /** Shared-doc override (tests). Defaults to the live collab session's. */
  yjsDoc?: YjsDocument;
  now?: () => number;
}

export interface MirrorPageResult {
  pageId: string;
  /** Constructs the provider transform couldn't mirror faithfully. */
  warnings: ImportWarningInfo[];
  /** Child resources the source carried at fetch time (JP-475) — best-effort;
   *  empty against an older control plane. */
  childRefs: ExternalResource[];
}

function resolveYjsDoc(deps: MirrorPageDeps): YjsDocument {
  if (deps.yjsDoc) return deps.yjsDoc;
  const collab = useCollaborationStore.getState();
  const yjsDoc = collab.getYjsDocument();
  if (!collab.isActive || !yjsDoc) {
    throw new MirrorPageError(
      'no_live_doc',
      'Mirror pages need a live workspace document — open the document online and try again.',
    );
  }
  return yjsDoc;
}

function defaultFetch(provider: string, externalId: string): Promise<FetchedMirrorContent> {
  return webClient.fetchIntegrationResource(provider, externalId);
}

/** Parse control-plane prose HTML with the registered editor schema (lenient —
 *  fits-to-schema, never throws on content; throws only if no editor loaded). */
function proseJsonFromHtml(html: string): JSONContent {
  const schema = getProseSchema();
  const dom = new window.DOMParser().parseFromString(html, 'text/html');
  return PMDOMParser.fromSchema(schema).parse(dom.body).toJSON() as JSONContent;
}

function mirrorMetaFrom(
  sourceRef: MirrorSourceRef,
  syncedAt: number,
  parentExternalId?: string,
): PageMirrorMeta {
  return {
    provider: sourceRef.provider,
    externalId: sourceRef.externalId,
    syncedAt,
    ...(sourceRef.url ? { url: sourceRef.url } : {}),
    ...(sourceRef.iconEmoji ? { iconEmoji: sourceRef.iconEmoji } : {}),
    ...(sourceRef.version ? { version: sourceRef.version } : {}),
    ...(parentExternalId ? { parentExternalId } : {}),
  };
}

export interface AddMirrorPageOpts {
  /** Insert position in `pageOrder` (default: append). */
  index?: number;
  /** Stamp the new page as a subpage of this source (JP-475). */
  parentExternalId?: string;
  /** Make the new page active (default true; batch ingest passes false). */
  activate?: boolean;
}

/**
 * Mirror one external resource into a NEW read-only page of the open document
 * and (by default) make it active. Returns the page id + the provider's
 * fidelity warnings (surface them — silently dropped content erodes trust in
 * mirrors) + the source's child refs (the subpage-ingestion input).
 */
export async function addMirrorPage(
  provider: string,
  externalId: string,
  deps: MirrorPageDeps = {},
  opts: AddMirrorPageOpts = {},
): Promise<MirrorPageResult> {
  const yjsDoc = resolveYjsDoc(deps);
  const fetched = await (deps.fetchResource ?? defaultFetch)(provider, externalId);
  const content = proseJsonFromHtml(fetched.proseHtml);

  const pages = useRichTextPagesStore.getState();
  const pageId = pages.createPage(
    fetched.title || 'Untitled mirror',
    undefined,
    undefined,
    opts.index !== undefined ? { index: opts.index } : undefined,
  );
  yjsDoc.setProse(pageId, content);
  pages.setPageMirror(pageId, mirrorMetaFrom(fetched.sourceRef, (deps.now ?? Date.now)(), opts.parentExternalId));
  if (opts.activate !== false) pages.setActivePage(pageId);

  return { pageId, warnings: fetched.warnings, childRefs: fetched.childRefs ?? [] };
}

/**
 * Re-fetch a mirror page's source and update content (merge-safe fragment
 * diff), title (follows the source), and provenance stamps in place.
 * `parentExternalId` is CLIENT-side provenance the server never echoes — it
 * must be carried over, or refreshing a subpage silently orphans its family.
 */
export async function refreshMirrorPage(pageId: string, deps: MirrorPageDeps = {}): Promise<MirrorPageResult> {
  const page = useRichTextPagesStore.getState().pages[pageId];
  const mirror = page?.mirror;
  if (!page || !mirror) {
    throw new MirrorPageError('not_a_mirror', 'This page is not a mirror — nothing to refresh.');
  }
  const yjsDoc = resolveYjsDoc(deps);
  const fetched = await (deps.fetchResource ?? defaultFetch)(mirror.provider, mirror.externalId);

  yjsDoc.setProse(pageId, proseJsonFromHtml(fetched.proseHtml));
  const pages = useRichTextPagesStore.getState();
  if (fetched.title && fetched.title !== page.name) {
    pages.renamePage(pageId, fetched.title);
  }
  pages.setPageMirror(pageId, mirrorMetaFrom(fetched.sourceRef, (deps.now ?? Date.now)(), mirror.parentExternalId));

  return { pageId, warnings: fetched.warnings, childRefs: fetched.childRefs ?? [] };
}

/**
 * Detach a mirror page: clear its provenance so it becomes a normal editable
 * page. Content stays exactly as last synced. Irreversible (re-adding creates
 * a new mirror page) — confirm in the UI before calling. Detaching a family
 * parent leaves its subpages as roots (derivation orphans, no cascades).
 */
export function detachMirrorPage(pageId: string): void {
  const page = useRichTextPagesStore.getState().pages[pageId];
  if (!page?.mirror) {
    throw new MirrorPageError('not_a_mirror', 'This page is not a mirror — nothing to detach.');
  }
  useRichTextPagesStore.getState().setPageMirror(pageId, undefined);
}

// ---------------------------------------------------------------------------
// Subpage ingestion (JP-475)
// ---------------------------------------------------------------------------

/** Inter-request delay for batch ingest — Notion allows ~3 req/s and neither
 *  the control plane nor the framework retries a 429 (it surfaces as 502). */
const INGEST_DELAY_MS = 350;
/** Recursion floor/ceiling: children of the requested parent are depth 1. */
const MAX_INGEST_DEPTH = 3;
/** Pages per ingest run — bounds latency, storage growth, and rate exposure. */
const MAX_INGEST_TOTAL = 25;

export interface SubpageCandidate {
  externalId: string;
  title: string;
  url?: string;
  /** 'present' = a mirror of this source already exists in the document. */
  status: 'new' | 'present';
}

export interface SubpageListing {
  parentPageId: string;
  provider: string;
  /** The parent's children as of the fresh fetch, in source order. */
  candidates: SubpageCandidate[];
  /** In-doc subpages of this parent NOT seen in the latest fetch — possibly
   *  nested deeper than the fetch budget, possibly removed at source. Info
   *  only; never auto-deleted. */
  unseen: { pageId: string; name: string }[];
  /** Warnings from the parent refresh that rode along. */
  warnings: ImportWarningInfo[];
}

/**
 * Fresh listing for the ingest dialog. Refreshes the parent (ingestion always
 * works against current source state — the fetch is the refresh) and diffs its
 * `childRefs` against the document's existing mirrors.
 */
export async function listSubpages(parentPageId: string, deps: MirrorPageDeps = {}): Promise<SubpageListing> {
  const parentMirror = useRichTextPagesStore.getState().pages[parentPageId]?.mirror;
  if (!parentMirror) {
    throw new MirrorPageError('not_a_mirror', 'This page is not a mirror — subpages come from the source.');
  }
  const { warnings, childRefs } = await refreshMirrorPage(parentPageId, deps);

  const state = useRichTextPagesStore.getState();
  const index = buildMirrorFamilyIndex(state.pages, state.pageOrder);
  const candidates: SubpageCandidate[] = childRefs.map((c) => ({
    externalId: c.externalId,
    title: c.title,
    ...(c.url ? { url: c.url } : {}),
    status: index.byExternal.has(externalKey(parentMirror.provider, c.externalId)) ? 'present' : 'new',
  }));

  const seen = new Set(childRefs.map((c) => c.externalId));
  const unseen = (index.childrenOf.get(parentPageId) ?? [])
    .filter((id) => {
      const m = state.pages[id]?.mirror;
      return m !== undefined && !seen.has(m.externalId);
    })
    .map((id) => ({ pageId: id, name: state.pages[id]?.name ?? 'Untitled' }));

  return { parentPageId, provider: parentMirror.provider, candidates, unseen, warnings };
}

export interface IngestSubpagesOpts {
  /** Also ingest the children's children (depth-capped). */
  recurse?: boolean;
  onProgress?: (done: number, total: number, currentTitle: string) => void;
  signal?: AbortSignal;
}

export interface IngestOutcome {
  added: number;
  skipped: number;
  failed: { title: string; message: string }[];
  warnings: ImportWarningInfo[];
  /** Children left out by the per-run total/depth caps. */
  truncated: number;
  /** True when the run stopped early (cancel, or the active doc changed). */
  aborted: boolean;
}

interface IngestQueueItem {
  externalId: string;
  title: string;
  parentPageId: string;
  depth: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ingest the selected subpages of a mirror page, sequentially (provider rate
 * limits; failures collect instead of stopping the run). Each child lands
 * directly after its parent's contiguous block, so the physical order reads
 * depth-first out of the box. Race-guarded: a child a collab peer mirrored
 * mid-run is skipped, and the run aborts if the active document changes.
 */
export async function ingestSubpages(
  parentPageId: string,
  selection: { externalId: string; title: string }[],
  opts: IngestSubpagesOpts = {},
  deps: MirrorPageDeps = {},
): Promise<IngestOutcome> {
  const parentMirror = useRichTextPagesStore.getState().pages[parentPageId]?.mirror;
  if (!parentMirror) {
    throw new MirrorPageError('not_a_mirror', 'This page is not a mirror — subpages come from the source.');
  }
  const provider = parentMirror.provider;
  const docAtStart = usePersistenceStore.getState().currentDocumentId;

  const outcome: IngestOutcome = { added: 0, skipped: 0, failed: [], warnings: [], truncated: 0, aborted: false };
  const queue: IngestQueueItem[] = selection.map((s) => ({ ...s, parentPageId, depth: 1 }));
  let processed = 0;

  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;

    if (opts.signal?.aborted || usePersistenceStore.getState().currentDocumentId !== docAtStart) {
      outcome.aborted = true;
      break;
    }
    if (processed >= MAX_INGEST_TOTAL) {
      outcome.truncated = queue.length + 1;
      break;
    }

    const state = useRichTextPagesStore.getState();
    const index = buildMirrorFamilyIndex(state.pages, state.pageOrder);

    // Peer race: someone mirrored this source while the run was underway.
    if (index.byExternal.has(externalKey(provider, item.externalId))) {
      outcome.skipped += 1;
      continue;
    }
    // The parent page can vanish mid-run (peer delete); land the child at the
    // end rather than dropping it — the derivation treats it as an orphan-root.
    const parentPage = state.pages[item.parentPageId];
    const parentExternalId = parentPage?.mirror?.externalId ?? parentMirror.externalId;

    opts.onProgress?.(processed, processed + queue.length + 1, item.title);
    if (processed > 0) await sleep(INGEST_DELAY_MS);

    try {
      const result = await addMirrorPage(provider, item.externalId, deps, {
        index: subtreeInsertionIndex(index, state.pageOrder, item.parentPageId),
        parentExternalId,
        activate: false,
      });
      outcome.added += 1;
      outcome.warnings.push(...result.warnings);
      if (opts.recurse && result.childRefs.length > 0) {
        if (item.depth >= MAX_INGEST_DEPTH) {
          outcome.truncated += result.childRefs.length;
        } else {
          queue.push(
            ...result.childRefs.map((c) => ({
              externalId: c.externalId,
              title: c.title,
              parentPageId: result.pageId,
              depth: item.depth + 1,
            })),
          );
        }
      }
    } catch (e) {
      outcome.failed.push({ title: item.title, message: e instanceof Error ? e.message : 'Fetch failed.' });
    }
    processed += 1;
  }

  return outcome;
}
