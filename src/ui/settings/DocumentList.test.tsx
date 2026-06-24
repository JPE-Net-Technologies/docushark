/**
 * DocumentList — guards the collection-management surface stays wired (JP-365).
 * When grouped by collection, each section's ⋯ menu must invoke the model's
 * rename / delete handlers. (The Group control that flips on grouping lives in
 * DocumentsHome; here we feed `groupedSections` directly.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DocumentList } from './DocumentList';
import type { DocumentBrowserModel } from './useDocumentBrowserModel';
import type { Collection } from '../../store/collectionStore';

const collection: Collection = { id: 'c1', name: 'Work', order: 0, createdAt: 0 };

function stubModel(over: Partial<DocumentBrowserModel> = {}): DocumentBrowserModel {
  return {
    // Non-empty so the list (not the empty state) renders; not iterated in the
    // grouped branch, so a placeholder record is fine.
    documentList: [{ type: 'local', id: 'l1', name: 'Doc', pageCount: 1, createdAt: 0, modifiedAt: 0 }],
    groupedSections: [{ key: 'c1', collection, docs: [] }],
    view: 'list',
    searchQuery: '',
    filterMode: 'all',
    collapsedMap: {},
    toggleCollapsed: vi.fn(),
    activeCollectionMenu: 'c1', // pre-open the section menu
    setActiveCollectionMenu: vi.fn(),
    handleRenameCollection: vi.fn(),
    handleDeleteCollection: vi.fn(),
    handleRecolor: vi.fn(),
    ...over,
  } as unknown as DocumentBrowserModel;
}

describe('DocumentList — collection management menu', () => {
  beforeEach(() => cleanup());

  it('renders the collection section header', () => {
    render(<DocumentList model={stubModel()} />);
    expect(screen.getByText('Work')).toBeTruthy();
  });

  it('invokes handleDeleteCollection with the collection', () => {
    const handleDeleteCollection = vi.fn();
    render(<DocumentList model={stubModel({ handleDeleteCollection })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete collection' }));
    expect(handleDeleteCollection).toHaveBeenCalledWith(collection);
  });

  it('invokes handleRenameCollection with the collection', () => {
    const handleRenameCollection = vi.fn();
    render(<DocumentList model={stubModel({ handleRenameCollection })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Rename…' }));
    expect(handleRenameCollection).toHaveBeenCalledWith(collection);
  });
});
