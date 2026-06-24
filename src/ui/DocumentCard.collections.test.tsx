/**
 * Per-card "Move to collection" menu (JP-365) — single-document collection
 * assignment, which used to be possible only via multi-select bulk actions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DocumentCard } from './DocumentCard';
import type { LocalDocument } from '../types/DocumentRegistry';
import type { Collection } from '../store/collectionStore';

const record: LocalDocument = {
  type: 'local',
  id: 'l1',
  name: 'My Doc',
  pageCount: 1,
  createdAt: 0,
  modifiedAt: 0,
};

const collections: Collection[] = [
  { id: 'c1', name: 'Work', order: 0, createdAt: 0 },
  { id: 'c2', name: 'Personal', order: 1, createdAt: 0 },
];

describe('DocumentCard — Move to collection', () => {
  beforeEach(() => cleanup());

  it('shows no move affordance when onAssignCollection is absent', () => {
    render(<DocumentCard record={record} collections={collections} />);
    expect(screen.queryByRole('button', { name: 'Move to collection' })).toBeNull();
  });

  it('opens the menu and assigns the doc to a chosen collection', () => {
    const onAssign = vi.fn();
    render(
      <DocumentCard
        record={record}
        collections={collections}
        currentCollectionId={null}
        onAssignCollection={onAssign}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Move to collection' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Personal' }));

    expect(onAssign).toHaveBeenCalledWith('l1', 'c2');
  });

  it('offers "Remove from collection" only when assigned, and passes null', () => {
    const onAssign = vi.fn();
    const { rerender } = render(
      <DocumentCard
        record={record}
        collections={collections}
        currentCollectionId={null}
        onAssignCollection={onAssign}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Move to collection' }));
    expect(screen.queryByRole('menuitem', { name: 'Remove from collection' })).toBeNull();

    // Now assigned to c1 → the (still-open) menu gains the remove action.
    rerender(
      <DocumentCard
        record={record}
        collections={collections}
        currentCollectionId="c1"
        onAssignCollection={onAssign}
      />,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from collection' }));

    expect(onAssign).toHaveBeenCalledWith('l1', null);
  });

  it('routes "+ New collection…" to the create-for-doc handler', () => {
    const onCreateFor = vi.fn();
    render(
      <DocumentCard
        record={record}
        collections={collections}
        currentCollectionId={null}
        onAssignCollection={vi.fn()}
        onCreateCollectionFor={onCreateFor}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Move to collection' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '+ New collection…' }));

    expect(onCreateFor).toHaveBeenCalledWith('l1');
  });
});
