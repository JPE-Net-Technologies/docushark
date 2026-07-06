/**
 * DocumentList — guards the collection-management surface stays wired (JP-365).
 * When grouped by collection, each section's ⋯ menu must invoke the model's
 * rename / delete handlers. (The Group control that flips on grouping lives in
 * DocumentsHome; here we feed `groupedSections` directly.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DocumentList, SelectionBar } from './DocumentList';
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

/* ── SelectionBar (JP-385 facelift) ─────────────────────────────────────────── */

function selectionModel(over: Partial<DocumentBrowserModel> = {}): DocumentBrowserModel {
  return stubModel({
    documentList: [
      { type: 'local', id: 'l1', name: 'One', pageCount: 1, createdAt: 0, modifiedAt: 0 },
      { type: 'local', id: 'l2', name: 'Two', pageCount: 1, createdAt: 0, modifiedAt: 0 },
    ] as DocumentBrowserModel['documentList'],
    selectedIds: new Set(['l1']),
    collections: [collection],
    handleSelectAll: vi.fn(),
    clearSelection: vi.fn(),
    handleBulkAssign: vi.fn(),
    handleBulkAssignNewCollection: vi.fn(),
    handleBulkExport: vi.fn(),
    handleBulkDelete: vi.fn(),
    ...over,
  });
}

describe('SelectionBar', () => {
  beforeEach(() => cleanup());

  it('shows the count, Select all for a partial selection, and Clear', () => {
    const handleSelectAll = vi.fn();
    const clearSelection = vi.fn();
    render(<SelectionBar model={selectionModel({ handleSelectAll, clearSelection })} />);

    expect(screen.getByText('1 selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select all (2)' }));
    expect(handleSelectAll).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(clearSelection).toHaveBeenCalled();
  });

  it('hides Select all when everything is already selected', () => {
    render(<SelectionBar model={selectionModel({ selectedIds: new Set(['l1', 'l2']) })} />);
    expect(screen.queryByRole('button', { name: /Select all/ })).toBeNull();
  });

  it('assigns the selection through the collection menu', () => {
    const handleBulkAssign = vi.fn();
    render(<SelectionBar model={selectionModel({ handleBulkAssign })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add to collection' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Work' }));
    expect(handleBulkAssign).toHaveBeenCalledWith('c1');

    fireEvent.click(screen.getByRole('button', { name: 'Add to collection' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from collection' }));
    expect(handleBulkAssign).toHaveBeenCalledWith(null);
  });

  it('wires Export and Delete to the bulk handlers', () => {
    const handleBulkExport = vi.fn();
    const handleBulkDelete = vi.fn();
    render(<SelectionBar model={selectionModel({ handleBulkExport, handleBulkDelete })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(handleBulkExport).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(handleBulkDelete).toHaveBeenCalled();
  });
});
