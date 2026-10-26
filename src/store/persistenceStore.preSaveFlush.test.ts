/**
 * DSK-199: every save captures what the live editors hold first.
 *
 * The local prose editor mirrors its content into `richTextPagesStore` (the
 * copy a reload reads back) on page switch, on unmount and every five seconds,
 * and `saveDocument` serialized that store as it stood. Text typed since the
 * last copy missed every save — the unload and app-switch flushes too — so a
 * reload lost it, and the stale copy was saved back over the newer one. The
 * editor panel now registers a pre-save flush that the document build runs
 * before reading any store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const cacheMock = vi.hoisted(() => ({
  put: vi.fn(async () => {}),
  getMeta: vi.fn(() => null),
}));
vi.mock('../storage/RelayDocumentCache', () => ({ RelayDocumentCache: cacheMock }));

const syncManagerMock = vi.hoisted(() => ({
  queueSave: vi.fn(() => ({ id: 'op-1' })),
  hasPendingChanges: vi.fn(() => false),
  processQueueForHost: vi.fn(async () => []),
}));
vi.mock('../collaboration/SyncStateManager', () => ({
  getSyncStateManager: () => syncManagerMock,
}));

import { usePersistenceStore } from './persistenceStore';
import { useRichTextPagesStore } from './richTextPagesStore';
import { registerPreSaveFlush, runPreSaveFlushes } from './preSaveFlush';

function storedPageHtml(docId: string, pageId: string): string | undefined {
  const raw = localStorage.getItem(`docushark-doc-${docId}`);
  if (!raw) return undefined;
  const doc = JSON.parse(raw) as { richTextPages?: { pages: Record<string, { content: string }> } };
  return doc.richTextPages?.pages[pageId]?.content;
}

describe('DSK-199: saves capture the live editor first', () => {
  let unregister: (() => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    usePersistenceStore.getState().newDocument('Field notes');
    usePersistenceStore.getState().saveDocument(); // give it an id
  });

  afterEach(() => {
    unregister?.();
    unregister = null;
  });

  it('saves what the editor holds, not the stale page copy', () => {
    const { activePageId } = useRichTextPagesStore.getState();
    const pageId = activePageId!;
    useRichTextPagesStore.getState().updatePageContent(pageId, '<p>Typed before the last copy.</p>');

    // The editor has moved on since its last copy into the store.
    unregister = registerPreSaveFlush(() =>
      useRichTextPagesStore.getState().updatePageContent(pageId, '<p>Typed a second before reload.</p>'),
    );

    usePersistenceStore.getState().saveDocument();

    const docId = usePersistenceStore.getState().currentDocumentId!;
    expect(storedPageHtml(docId, pageId)).toBe('<p>Typed a second before reload.</p>');
  });

  it('captures the editor on Save As too, so the copy has the latest text', () => {
    const pageId = useRichTextPagesStore.getState().activePageId!;
    unregister = registerPreSaveFlush(() =>
      useRichTextPagesStore.getState().updatePageContent(pageId, '<p>Latest.</p>'),
    );

    usePersistenceStore.getState().saveDocumentAs('Field notes (copy)');

    const copyId = usePersistenceStore.getState().currentDocumentId!;
    expect(storedPageHtml(copyId, pageId)).toBe('<p>Latest.</p>');
  });

  it('still saves when a flush fails', () => {
    const pageId = useRichTextPagesStore.getState().activePageId!;
    useRichTextPagesStore.getState().updatePageContent(pageId, '<p>What the store holds.</p>');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    unregister = registerPreSaveFlush(() => {
      throw new Error('editor destroyed mid-save');
    });

    usePersistenceStore.getState().saveDocument();

    const docId = usePersistenceStore.getState().currentDocumentId!;
    expect(storedPageHtml(docId, pageId)).toBe('<p>What the store holds.</p>');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('preSaveFlush registry', () => {
  it('runs registered flushes until they unregister', () => {
    const flush = vi.fn();
    const unregister = registerPreSaveFlush(flush);
    runPreSaveFlushes();
    expect(flush).toHaveBeenCalledTimes(1);

    unregister();
    runPreSaveFlushes();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
