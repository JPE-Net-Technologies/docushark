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

import { webClient, type FetchedMirrorContent, type ImportWarningInfo, type MirrorSourceRef } from '../api/webClient';
import { getProseSchema } from '../collaboration/proseSchema';
import { useCollaborationStore } from '../collaboration/collaborationStore';
import type { YjsDocument } from '../collaboration/YjsDocument';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import type { PageMirrorMeta } from '../types/PageMirror';

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

function mirrorMetaFrom(sourceRef: MirrorSourceRef, syncedAt: number): PageMirrorMeta {
  return {
    provider: sourceRef.provider,
    externalId: sourceRef.externalId,
    syncedAt,
    ...(sourceRef.url ? { url: sourceRef.url } : {}),
    ...(sourceRef.iconEmoji ? { iconEmoji: sourceRef.iconEmoji } : {}),
    ...(sourceRef.version ? { version: sourceRef.version } : {}),
  };
}

/**
 * Mirror one external resource into a NEW read-only page of the open document
 * and make it active. Returns the page id + the provider's fidelity warnings
 * (surface them — silently dropped content erodes trust in mirrors).
 */
export async function addMirrorPage(
  provider: string,
  externalId: string,
  deps: MirrorPageDeps = {},
): Promise<MirrorPageResult> {
  const yjsDoc = resolveYjsDoc(deps);
  const fetched = await (deps.fetchResource ?? defaultFetch)(provider, externalId);
  const content = proseJsonFromHtml(fetched.proseHtml);

  const pages = useRichTextPagesStore.getState();
  const pageId = pages.createPage(fetched.title || 'Untitled mirror');
  yjsDoc.setProse(pageId, content);
  pages.setPageMirror(pageId, mirrorMetaFrom(fetched.sourceRef, (deps.now ?? Date.now)()));
  pages.setActivePage(pageId);

  return { pageId, warnings: fetched.warnings };
}

/**
 * Re-fetch a mirror page's source and update content (merge-safe fragment
 * diff), title (follows the source), and provenance stamps in place.
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
  pages.setPageMirror(pageId, mirrorMetaFrom(fetched.sourceRef, (deps.now ?? Date.now)()));

  return { pageId, warnings: fetched.warnings };
}

/**
 * Detach a mirror page: clear its provenance so it becomes a normal editable
 * page. Content stays exactly as last synced. Irreversible (re-adding creates
 * a new mirror page) — confirm in the UI before calling.
 */
export function detachMirrorPage(pageId: string): void {
  const page = useRichTextPagesStore.getState().pages[pageId];
  if (!page?.mirror) {
    throw new MirrorPageError('not_a_mirror', 'This page is not a mirror — nothing to detach.');
  }
  useRichTextPagesStore.getState().setPageMirror(pageId, undefined);
}
