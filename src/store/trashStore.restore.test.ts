/**
 * Restoring from Trash (DSK-13): a stranded copy comes back as a new personal
 * document; the user's own trashed documents come back as they were.
 *
 * A stranded copy came from a workspace document that may still exist, because
 * its access was revoked rather than the document deleted. Restored under the
 * old id, it would collide with that document as soon as it was moved back to
 * a workspace: the save lands on someone else's document and is refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  adoptDocument: vi.fn(),
  getTrashItem: vi.fn(),
  recoverFromTrash: vi.fn(),
}));

vi.mock('../storage/TrashStorage', () => ({
  moveToTrash: vi.fn(),
  getTrashItems: vi.fn(() => []),
  getTrashItem: h.getTrashItem,
  getTrashedBlobReferences: vi.fn(() => new Set<string>()),
  recoverFromTrash: h.recoverFromTrash,
  permanentlyDeleteFromTrash: vi.fn(),
  emptyTrash: vi.fn(() => 0),
  cleanupExpiredTrash: vi.fn(() => 0),
}));
vi.mock('../storage/AssetBundler', () => ({
  collectBlobReferences: vi.fn(() => []),
}));
vi.mock('../storage/BlobStorage', () => ({
  blobStorage: { listAllBlobs: vi.fn(async () => []) },
}));
vi.mock('../storage/BlobGarbageCollector', () => ({
  BlobGarbageCollector: class {
    collectGarbageIncremental = vi.fn(async () => {});
  },
}));
vi.mock('./persistenceStore', () => ({
  usePersistenceStore: { getState: () => ({ getDocumentList: () => [], adoptDocument: h.adoptDocument }) },
  loadDocumentFromStorage: vi.fn(() => null),
}));

import { asPersonalCopy, useTrashStore } from './trashStore';
import type { DiagramDocument } from '../types/Document';

const ID = 'doc-workspace-1';

function workspaceDoc(): DiagramDocument {
  return {
    id: ID,
    name: 'Field notes',
    ownerId: 'user-owner',
    sharedWith: [{ userId: 'user-me', userName: 'Me', permission: 'edit', sharedAt: 1 }],
    pages: { p1: { id: 'p1', name: 'Page 1', shapes: {}, shapeOrder: [] } },
    pageOrder: ['p1'],
    richTextPages: { pages: { r1: { id: 'r1', name: 'Notes', content: '<p>Unsynced paragraph</p>' } }, pageOrder: ['r1'] },
  } as unknown as DiagramDocument;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.recoverFromTrash.mockReturnValue({ success: true, document: workspaceDoc() });
});

describe('asPersonalCopy', () => {
  it('gives the copy a new id and no workspace owner or shares, keeping its content', () => {
    const copy = asPersonalCopy(workspaceDoc());
    expect(copy.id).not.toBe(ID);
    expect(copy.id.length).toBeGreaterThan(0);
    expect(copy).not.toHaveProperty('ownerId');
    expect(copy).not.toHaveProperty('sharedWith');
    expect(copy.name).toBe('Field notes');
    expect(copy.pages).toEqual(workspaceDoc().pages);
    expect(copy.richTextPages).toEqual(workspaceDoc().richTextPages);
  });
});

describe('restoring from Trash', () => {
  it('restores a stranded copy as a new personal document', async () => {
    h.getTrashItem.mockReturnValue({ id: ID, kind: 'stranded' });
    expect(await useTrashStore.getState().restore(ID)).toBe(true);

    const adopted = h.adoptDocument.mock.calls[0]?.[0] as DiagramDocument;
    expect(adopted.id).not.toBe(ID);
    expect(adopted).not.toHaveProperty('ownerId');
    expect(adopted).not.toHaveProperty('sharedWith');
    expect(adopted.richTextPages).toEqual(workspaceDoc().richTextPages);
  });

  it('restores the user’s own trashed document under its own id', async () => {
    h.getTrashItem.mockReturnValue({ id: ID, kind: 'local' });
    await useTrashStore.getState().restore(ID);
    expect((h.adoptDocument.mock.calls[0]?.[0] as DiagramDocument).id).toBe(ID);
  });

  it('treats an entry without a kind as the user’s own', async () => {
    h.getTrashItem.mockReturnValue({ id: ID });
    await useTrashStore.getState().restore(ID);
    expect((h.adoptDocument.mock.calls[0]?.[0] as DiagramDocument).id).toBe(ID);
  });
});
