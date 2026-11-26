/**
 * Document settings through the real local load and save (DSK-246). A save
 * rebuilds the document from the live stores, so it must write back every
 * setting the document held, including ones a newer build wrote.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import { useDocumentSettingsStore } from './documentSettingsStore';
import { createDocument, STORAGE_KEYS, type DiagramDocument } from '../types/Document';
import type { DocumentSettings } from '../types/DocumentSettings';

/** Write a DiagramDocument into localStorage where `loadDocument` reads it. */
function seedDoc(id: string, settings?: DocumentSettings): void {
  const doc: DiagramDocument = createDocument(`Doc ${id}`, id, `${id}-p1`);
  if (settings) doc.settings = settings;
  localStorage.setItem(`${STORAGE_KEYS.DOCUMENT_PREFIX}${id}`, JSON.stringify(doc));
}

function stored(id: string): DiagramDocument {
  return JSON.parse(localStorage.getItem(`${STORAGE_KEYS.DOCUMENT_PREFIX}${id}`) ?? 'null') as DiagramDocument;
}

const persistence = () => usePersistenceStore.getState();
const settingsStore = () => useDocumentSettingsStore.getState();

beforeEach(() => {
  localStorage.clear();
  useDocumentSettingsStore.setState({ settings: {}, documentId: undefined });
  vi.restoreAllMocks();
});

describe('document settings in a local document', () => {
  it('a save keeps every setting, keys this build does not know included', () => {
    const settings = { font: "'Source Serif 4', serif", fromANewerBuild: { nested: [1, true, null] } };
    seedDoc('doc-a', settings);

    expect(persistence().loadDocument('doc-a')).toBe(true);
    persistence().saveDocument();

    expect(stored('doc-a').settings).toEqual(settings);
  });

  it('saves a changed setting beside the others', () => {
    seedDoc('doc-a', { font: 'Inter, sans-serif', other: 1 });
    persistence().loadDocument('doc-a');

    settingsStore().set('font', 'Caveat, cursive');
    persistence().saveDocument();

    expect(stored('doc-a').settings).toEqual({ font: 'Caveat, cursive', other: 1 });
  });

  it('writes no settings field for a document without settings', () => {
    seedDoc('doc-a');
    persistence().loadDocument('doc-a');
    persistence().saveDocument();
    expect(stored('doc-a')).not.toHaveProperty('settings');
  });

  it('never carries one document’s settings into another, or into a new one', () => {
    seedDoc('doc-a', { font: 'Caveat, cursive' });
    seedDoc('doc-b');

    persistence().loadDocument('doc-a');
    persistence().loadDocument('doc-b');
    expect(settingsStore().settings).toEqual({});
    persistence().saveDocument();
    expect(stored('doc-b')).not.toHaveProperty('settings');

    persistence().loadDocument('doc-a');
    persistence().newDocument();
    expect(settingsStore().settings).toEqual({});
  });

  it('a save that races the first load keeps the stored settings', () => {
    seedDoc('doc-a', { font: 'Caveat, cursive' });
    // The document is current, but nothing has loaded the settings store yet.
    usePersistenceStore.setState({ currentDocumentId: 'doc-a', currentDocumentName: 'Doc doc-a' } as never);

    persistence().saveDocument();

    expect(stored('doc-a').settings).toEqual({ font: 'Caveat, cursive' });
  });
});
