/**
 * Per-card "Move to collection" menu (JP-365) — single-document collection
 * assignment, which used to be possible only via multi-select bulk actions.
 * Since JP-385 the menu lives inside the card's overflow ("More actions")
 * menu as a submenu, so every test opens it through the kebab.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DocumentCard } from './DocumentCard';
import type { LocalDocument, RemoteDocument } from '../types/DocumentRegistry';
import type { Collection } from '../store/collectionStore';

const record: LocalDocument = {
  type: 'local',
  id: 'l1',
  name: 'My Doc',
  pageCount: 1,
  createdAt: 0,
  modifiedAt: 0,
};

const remoteRecord: RemoteDocument = {
  type: 'remote',
  id: 'r1',
  name: 'Team Doc',
  pageCount: 1,
  createdAt: 0,
  modifiedAt: 0,
  relayId: 'localhost:9876',
  workspaceId: 'ws-1',
  ownerId: 'u1',
  ownerName: 'A',
  permission: 'owner',
  syncState: 'synced',
  lastSyncedAt: 0,
};

const collections: Collection[] = [
  { id: 'c1', name: 'Work', order: 0, createdAt: 0 },
  { id: 'c2', name: 'Personal', order: 1, createdAt: 0 },
];

// One local + one workspace collection, for scope-filter tests.
const mixedCollections: Collection[] = [
  { id: 'loc', name: 'My Local', order: 0, createdAt: 0, scope: 'local' },
  { id: 'team', name: 'Team Space', order: 1, createdAt: 0, scope: 'workspace' },
];

/** Open the card's overflow menu, then its "Move to collection" submenu. */
function openCollectionMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move to collection' }));
}

describe('DocumentCard — Move to collection', () => {
  beforeEach(() => cleanup());

  it('shows no move affordance when onAssignCollection is absent', () => {
    render(<DocumentCard record={record} collections={collections} />);
    // No granted actions at all → no overflow menu either.
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Move to collection' })).toBeNull();
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

    openCollectionMenu();
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

    openCollectionMenu();
    expect(screen.queryByRole('menuitem', { name: 'Remove from collection' })).toBeNull();

    // Now assigned to c1 → the (still-open) submenu gains the remove action.
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

    openCollectionMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '+ New collection…' }));

    expect(onCreateFor).toHaveBeenCalledWith('l1');
  });

  it('lists only local collections for a local document (JP-366)', () => {
    render(
      <DocumentCard
        record={record}
        collections={mixedCollections}
        currentCollectionId={null}
        onAssignCollection={vi.fn()}
      />,
    );
    openCollectionMenu();

    expect(screen.getByRole('menuitem', { name: 'My Local' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Team Space' })).toBeNull();
  });

  it('lists only workspace collections for a workspace document (JP-366)', () => {
    render(
      <DocumentCard
        record={remoteRecord}
        collections={mixedCollections}
        currentCollectionId={null}
        onAssignCollection={vi.fn()}
      />,
    );
    openCollectionMenu();

    expect(screen.getByRole('menuitem', { name: 'Team Space' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'My Local' })).toBeNull();
  });
});
