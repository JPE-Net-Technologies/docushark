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
import { addMirrorPage, refreshMirrorPage, detachMirrorPage, MirrorPageError } from './mirrorPageService';

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
