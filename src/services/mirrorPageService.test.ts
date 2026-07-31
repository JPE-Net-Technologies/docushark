/**
 * JP-415 — mirror page service. Uses a REAL YjsDocument + registered
 * StarterKit schema (the proseInvariant.test.ts pattern) so the fragment
 * write path is the production one; only the control-plane fetch is faked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import { YjsDocument } from '../collaboration/YjsDocument';
import { registerProseSchema, __resetProseSchemaForTests } from '../collaboration/proseSchema';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import type { FetchedMirrorContent } from '../api/webClient';
import { addMirrorPage, refreshMirrorPage, detachMirrorPage, ingestSubpages, listSubpages, MirrorPageError } from './mirrorPageService';

const schema = getSchema([StarterKit.configure({ history: false })]);

function fetched(overrides: Partial<FetchedMirrorContent> = {}): FetchedMirrorContent {
  return {
    title: 'Team Handbook',
    proseHtml: '<h1>Welcome</h1><p>mirrored body</p>',
    blobCount: 0,
    warnings: [{ kind: 'unsupported-block', detail: 'block type "video" dropped' }],
    sourceRef: {
      provider: 'notion',
      externalId: 'p-1',
      url: 'https://www.notion.so/Synth-p-1',
      version: '2026-07-10T09:00:00.000Z',
    },
    ...overrides,
  };
}

describe('mirrorPageService (JP-415)', () => {
  let yjsDoc: YjsDocument;

  beforeEach(() => {
    registerProseSchema(schema);
    yjsDoc = new YjsDocument();
    useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null });
  });
  afterEach(() => {
    yjsDoc.destroy();
    __resetProseSchemaForTests();
  });

  it('addMirrorPage creates an active read-only page with content + provenance', async () => {
    const result = await addMirrorPage('notion', 'p-1', {
      yjsDoc,
      fetchResource: async () => fetched(),
      now: () => 1752600000000,
    });

    const state = useRichTextPagesStore.getState();
    expect(state.activePageId).toBe(result.pageId);
    const page = state.pages[result.pageId];
    expect(page?.name).toBe('Team Handbook');
    expect(page?.mirror).toEqual({
      provider: 'notion',
      externalId: 'p-1',
      url: 'https://www.notion.so/Synth-p-1',
      version: '2026-07-10T09:00:00.000Z',
      syncedAt: 1752600000000,
    });
    // Content landed in the page's fragment via the production write path.
    const frag = yjsDoc.getDoc().getXmlFragment(`prose:${result.pageId}`);
    expect(frag.toString()).toContain('Welcome');
    expect(frag.toString()).toContain('mirrored body');
    // Fidelity warnings surface to the caller.
    expect(result.warnings).toHaveLength(1);
  });

  it('refreshMirrorPage updates content, follows a source rename, restamps provenance', async () => {
    const { pageId } = await addMirrorPage('notion', 'p-1', {
      yjsDoc,
      fetchResource: async () => fetched(),
      now: () => 1,
    });

    await refreshMirrorPage(pageId, {
      yjsDoc,
      fetchResource: async () =>
        fetched({
          title: 'Team Handbook v2',
          proseHtml: '<h1>Welcome</h1><p>updated body</p>',
          warnings: [],
          sourceRef: { provider: 'notion', externalId: 'p-1', version: '2026-07-11T00:00:00.000Z' },
        }),
      now: () => 2,
    });

    const page = useRichTextPagesStore.getState().pages[pageId];
    expect(page?.name).toBe('Team Handbook v2');
    expect(page?.mirror?.version).toBe('2026-07-11T00:00:00.000Z');
    expect(page?.mirror?.syncedAt).toBe(2);
    const frag = yjsDoc.getDoc().getXmlFragment(`prose:${pageId}`);
    expect(frag.toString()).toContain('updated body');
    expect(frag.toString()).not.toContain('mirrored body');
  });

  it('detachMirrorPage clears provenance, keeping content; refresh then refuses', async () => {
    const { pageId } = await addMirrorPage('notion', 'p-1', {
      yjsDoc,
      fetchResource: async () => fetched(),
    });

    detachMirrorPage(pageId);
    const page = useRichTextPagesStore.getState().pages[pageId];
    expect(page?.mirror).toBeUndefined();

    await expect(refreshMirrorPage(pageId, { yjsDoc, fetchResource: async () => fetched() })).rejects.toThrow(
      MirrorPageError,
    );
    expect(() => detachMirrorPage(pageId)).toThrow(MirrorPageError);
  });

  it('addMirrorPage without a live collab session refuses with no_live_doc', async () => {
    // No yjsDoc dep and the collaboration store is inactive by default.
    await expect(addMirrorPage('notion', 'p-1', { fetchResource: async () => fetched() })).rejects.toMatchObject({
      code: 'no_live_doc',
    });
    // Nothing half-created.
    expect(useRichTextPagesStore.getState().pageOrder).toEqual([]);
  });
});

describe('subpage ingestion (JP-475)', () => {
  let yjsDoc: YjsDocument;

  beforeEach(() => {
    registerProseSchema(schema);
    yjsDoc = new YjsDocument();
    useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null });
  });
  afterEach(() => {
    yjsDoc.destroy();
    __resetProseSchemaForTests();
  });

  /** Per-source fake control plane; unknown ids fail like the route's 502. */
  function sourceMap(sources: Record<string, FetchedMirrorContent>) {
    return async (_provider: string, externalId: string): Promise<FetchedMirrorContent> => {
      const f = sources[externalId];
      if (!f) throw new Error(`fetch failed for ${externalId}`);
      return f;
    };
  }

  function src(externalId: string, title: string, childRefs: { externalId: string; title: string }[] = []): FetchedMirrorContent {
    return {
      title,
      proseHtml: `<p>${title} body</p>`,
      blobCount: 0,
      warnings: [],
      sourceRef: { provider: 'notion', externalId },
      childRefs,
    };
  }

  function orderNames(): string[] {
    const { pages, pageOrder } = useRichTextPagesStore.getState();
    return pageOrder.map((id) => pages[id]?.name ?? '?');
  }

  it('refreshMirrorPage PRESERVES parentExternalId (child-orphaning defect)', async () => {
    const sources = {
      'ext-p': src('ext-p', 'Parent', [{ externalId: 'ext-c', title: 'Child' }]),
      'ext-c': src('ext-c', 'Child'),
    };
    const deps = { yjsDoc, fetchResource: sourceMap(sources) };
    const { pageId: parentId } = await addMirrorPage('notion', 'ext-p', deps);
    await ingestSubpages(parentId, [{ externalId: 'ext-c', title: 'Child' }], {}, deps);

    const childId = useRichTextPagesStore.getState().pageOrder[1]!;
    expect(useRichTextPagesStore.getState().pages[childId]?.mirror?.parentExternalId).toBe('ext-p');

    // The server sourceRef never carries parentExternalId — refresh must not drop it.
    await refreshMirrorPage(childId, deps);
    expect(useRichTextPagesStore.getState().pages[childId]?.mirror?.parentExternalId).toBe('ext-p');
  });

  it('ingest inserts children depth-first after the parent, before later pages', async () => {
    const sources = {
      'ext-p': src('ext-p', 'Parent', [
        { externalId: 'ext-c1', title: 'C1' },
        { externalId: 'ext-c2', title: 'C2' },
      ]),
      'ext-c1': src('ext-c1', 'C1', [{ externalId: 'ext-g1', title: 'G1' }]),
      'ext-c2': src('ext-c2', 'C2'),
      'ext-g1': src('ext-g1', 'G1'),
    };
    const deps = { yjsDoc, fetchResource: sourceMap(sources) };
    const { pageId: parentId } = await addMirrorPage('notion', 'ext-p', deps);
    useRichTextPagesStore.getState().createPage('Notes');

    const outcome = await ingestSubpages(
      parentId,
      [
        { externalId: 'ext-c1', title: 'C1' },
        { externalId: 'ext-c2', title: 'C2' },
      ],
      { recurse: true },
      deps,
    );

    expect(outcome.added).toBe(3);
    expect(outcome.failed).toEqual([]);
    // G1 (processed LAST via the recursion queue) still lands under C1 —
    // physical order reads depth-first, and 'Notes' stays after the family.
    expect(orderNames()).toEqual(['Parent', 'C1', 'G1', 'C2', 'Notes']);
    // Batch ingest never steals the active page.
    expect(useRichTextPagesStore.getState().activePageId).toBe(parentId);
  }, 15000);

  it('listSubpages diffs candidates against the document and reports unseen children', async () => {
    const sources = {
      'ext-p': src('ext-p', 'Parent', [
        { externalId: 'ext-c1', title: 'C1' },
        { externalId: 'ext-c2', title: 'C2' },
      ]),
      'ext-c1': src('ext-c1', 'C1'),
    };
    const deps = { yjsDoc, fetchResource: sourceMap(sources) };
    const { pageId: parentId } = await addMirrorPage('notion', 'ext-p', deps);
    await ingestSubpages(parentId, [{ externalId: 'ext-c1', title: 'C1' }], {}, deps);

    // Simulate a child that exists in-doc but vanished from the source listing.
    const ghostId = useRichTextPagesStore.getState().createPage('Ghost');
    useRichTextPagesStore.getState().setPageMirror(ghostId, {
      provider: 'notion',
      externalId: 'ext-ghost',
      parentExternalId: 'ext-p',
      syncedAt: 1,
    });

    const listing = await listSubpages(parentId, deps);
    expect(listing.candidates).toEqual([
      { externalId: 'ext-c1', title: 'C1', status: 'present' },
      { externalId: 'ext-c2', title: 'C2', status: 'new' },
    ]);
    expect(listing.unseen).toEqual([{ pageId: ghostId, name: 'Ghost' }]);
  });

  it('collects per-child failures and keeps going; peers ingesting mid-run cause skips', async () => {
    const sources = {
      'ext-p': src('ext-p', 'Parent', [
        { externalId: 'ext-bad', title: 'Bad' },
        { externalId: 'ext-c2', title: 'C2' },
      ]),
      'ext-c2': src('ext-c2', 'C2'),
    };
    const deps = { yjsDoc, fetchResource: sourceMap(sources) };
    const { pageId: parentId } = await addMirrorPage('notion', 'ext-p', deps);
    // 'ext-c2' appears mid-run as if a collab peer mirrored it first.
    await addMirrorPage('notion', 'ext-c2', deps, { activate: false });

    const outcome = await ingestSubpages(
      parentId,
      [
        { externalId: 'ext-bad', title: 'Bad' },
        { externalId: 'ext-c2', title: 'C2' },
      ],
      {},
      deps,
    );
    expect(outcome.failed).toEqual([{ title: 'Bad', message: 'fetch failed for ext-bad' }]);
    expect(outcome.skipped).toBe(1);
    expect(outcome.added).toBe(0);
  });

  it('an aborted signal stops the run before the next child', async () => {
    const ac = new AbortController();
    ac.abort();
    const sources = { 'ext-p': src('ext-p', 'Parent', [{ externalId: 'ext-c1', title: 'C1' }]) };
    const deps = { yjsDoc, fetchResource: sourceMap(sources) };
    const { pageId: parentId } = await addMirrorPage('notion', 'ext-p', deps);

    const outcome = await ingestSubpages(parentId, [{ externalId: 'ext-c1', title: 'C1' }], { signal: ac.signal }, deps);
    expect(outcome.aborted).toBe(true);
    expect(outcome.added).toBe(0);
  });
});
