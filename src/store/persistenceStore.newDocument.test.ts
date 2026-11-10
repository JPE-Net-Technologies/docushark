/**
 * "New document" starts from nothing (DSK-253). Every per-document store must
 * be reset, or the previous document's content is copied into the new one by
 * its first save.
 *
 * The guard compares a new document's first save made right after a document
 * full of content (shapes, prose, references, fields, whiteboard, settings) with one made from a fresh start. It needs no list of
 * stores, so a per-document store added later and left out of `newDocument`
 * fails it too.
 */
import { expect, it, vi } from 'vitest';

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

import '../shapes/Rectangle';
import { usePersistenceStore } from './persistenceStore';
import { createDocument, STORAGE_KEYS, type DiagramDocument } from '../types/Document';
import type { Shape } from '../shapes/Shape';

const persistence = () => usePersistenceStore.getState();
const storedIds = () =>
  Object.keys(localStorage).filter((key) => key.startsWith(STORAGE_KEYS.DOCUMENT_PREFIX));

/** A document with something in every per-document store. */
function fullDocument(): DiagramDocument {
  const doc = createDocument('Full', 'doc-full', 'full-p1');
  const shape = {
    id: 'shape-1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, rotation: 0, opacity: 1,
    locked: false, visible: true, fill: '#fff', stroke: '#000', strokeWidth: 1, cornerRadius: 0,
  } as unknown as Shape;
  const page = doc.pages['full-p1']!;
  page.shapes = { 'shape-1': shape };
  page.shapeOrder = ['shape-1'];
  doc.richTextPages = {
    pages: { 'rt-full': { id: 'rt-full', name: 'Notes', content: '<p>Doc A prose</p>', order: 0, createdAt: 1, modifiedAt: 1 } },
    pageOrder: ['rt-full'],
    activePageId: 'rt-full',
  } as never;
  doc.references = { items: { knuth: { id: 'knuth', type: 'book', title: 'Doc A source' } }, itemOrder: ['knuth'] } as never;
  doc.fields = { fields: { client: { name: 'client', value: 'Acme Corp' } }, order: ['client'] } as never;
  doc.whiteboard = {
    boards: {
      'board-a': {
        id: 'board-a', name: 'Doc A board', createdAt: 1, noteOrder: ['note-a'],
        notes: { 'note-a': { id: 'note-a', x: 0, y: 0, width: 100, height: 100, color: '#fef3c7', content: 'Doc A private note', zIndex: 1, createdAt: 1, modifiedAt: 1 } },
      },
    },
    boardOrder: ['board-a'],
    activeBoardId: 'board-a',
    isVisible: true,
  };
  doc.settings = { font: "'Source Serif 4', serif", fromANewerBuild: 'kept' };
  return doc;
}

/** Create a new document, name it so it saves, save it, and return what was stored. */
function firstSaveOfANewDocument(): DiagramDocument {
  const before = new Set(storedIds());
  persistence().newDocument();
  usePersistenceStore.setState({ currentDocumentName: 'Named' } as never);
  persistence().saveDocument();
  const key = storedIds().find((id) => !before.has(id));
  expect(key, 'the new document was saved').toBeDefined();
  return JSON.parse(localStorage.getItem(key!) ?? 'null') as DiagramDocument;
}

/** Generated ids and timestamps differ between runs; everything else must not. */
function comparable(doc: DiagramDocument): unknown {
  const ids = new Map<string, string>();
  const id = (value: string) => {
    if (!/^[A-Za-z0-9_-]{21}$/.test(value)) return value;
    if (!ids.has(value)) ids.set(value, `id-${ids.size}`);
    return ids.get(value)!;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return id(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== 'createdAt' && key !== 'modifiedAt')
          .map(([key, inner]) => [id(key), walk(inner)]),
      );
    }
    return value;
  };
  const { id: _id, name: _name, ...rest } = doc;
  return walk(rest);
}

it('starts a new document from nothing, whatever was open before', () => {
  localStorage.clear();
  const fresh = comparable(firstSaveOfANewDocument());

  localStorage.setItem(`${STORAGE_KEYS.DOCUMENT_PREFIX}doc-full`, JSON.stringify(fullDocument()));
  expect(persistence().loadDocument('doc-full')).toBe(true);
  const afterFull = comparable(firstSaveOfANewDocument());

  expect(afterFull).toEqual(fresh);
});

it('saves nothing for an untouched new document opened after one with content', () => {
  localStorage.clear();
  localStorage.setItem(`${STORAGE_KEYS.DOCUMENT_PREFIX}doc-full`, JSON.stringify(fullDocument()));
  persistence().loadDocument('doc-full');

  persistence().newDocument();
  persistence().saveDocument();

  expect(storedIds()).toEqual([`${STORAGE_KEYS.DOCUMENT_PREFIX}doc-full`]);
});
