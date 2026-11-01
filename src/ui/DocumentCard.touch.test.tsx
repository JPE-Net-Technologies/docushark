/**
 * DocumentCard on touch (DSK-196). Nothing can be hover-revealed without a
 * hover, and one-tap Trash under a thumb is a misfire waiting to happen, so on
 * touch the quick actions live in the menu, and the menu is the way into
 * multi-select.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DocumentCard, sheetSummary } from './DocumentCard';
import type { CachedDocument, LocalDocument } from '../types/DocumentRegistry';

vi.mock('./confirm/confirmStore', () => ({ confirmDialog: vi.fn() }));

const local: LocalDocument = {
  type: 'local',
  id: 'l1',
  name: 'Field notes',
  pageCount: 2,
  createdAt: 0,
  modifiedAt: 0,
  sizeBytes: 1536,
};

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
}

describe('DocumentCard on touch (DSK-196)', () => {
  beforeEach(() => cleanup());

  it('renders no quick actions; the menu carries them', async () => {
    const onPublishToRelay = vi.fn();
    const onDelete = vi.fn();
    render(
      <DocumentCard record={local} touch onPublishToRelay={onPublishToRelay} onDelete={onDelete} mode="full" />,
    );
    expect(screen.queryByRole('button', { name: 'Move to Cloud' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move to Trash' })).toBeNull();

    openMenu();
    // The transfer is async; let its in-flight state settle inside act().
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Cloud' }));
    });
    expect(onPublishToRelay).toHaveBeenCalledWith('l1');
  });

  it('offers Move to personal from the menu', async () => {
    const onMoveToPersonal = vi.fn();
    render(<DocumentCard record={local} touch onMoveToPersonal={onMoveToPersonal} onDelete={vi.fn()} />);
    openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Move to personal' }));
    });
    expect(onMoveToPersonal).toHaveBeenCalledWith('l1');
  });

  it('is the way into multi-select: Select adds the card to the selection', () => {
    const onSelectToggle = vi.fn();
    render(<DocumentCard record={local} touch onSelectToggle={onSelectToggle} onDelete={vi.fn()} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Select' }));
    // `meta` — the same toggle a select-mode tap makes, never a range.
    expect(onSelectToggle).toHaveBeenCalledWith('l1', { shift: false, meta: true });
  });

  it('says Deselect for a selected card', () => {
    render(<DocumentCard record={local} touch isSelected onSelectToggle={vi.fn()} onDelete={vi.fn()} />);
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Deselect' })).toBeTruthy();
  });

  it('keeps the mouse layout without touch: quick actions, no Select in the menu', () => {
    render(
      <DocumentCard record={local} onPublishToRelay={vi.fn()} onSelectToggle={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Move to Cloud' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move to Trash' })).toBeTruthy();
    openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Select' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Move to Cloud' })).toBeNull();
  });

  it('renders the size for the narrow two-line row in list mode', () => {
    render(<DocumentCard record={local} mode="full" />);
    expect(document.querySelector('.document-card__size-inline')?.textContent).toBe('1.5 KB');
  });
});

describe('sheetSummary', () => {
  it('says where the document lives, when it changed, and its size', () => {
    const now = Date.now();
    expect(sheetSummary({ ...local, modifiedAt: now })).toBe('Personal · Edited just now · 1.5 KB');
    const unsized: LocalDocument = { type: 'local', id: 'l2', name: 'Draft', pageCount: 1, createdAt: 0, modifiedAt: now - 3 * 3600_000 };
    expect(sheetSummary(unsized)).toBe('Personal · Edited 3h ago');
  });
});

describe('DocumentCard sync badge', () => {
  beforeEach(() => cleanup());

  it('does not say Offline twice for an offline copy that cannot reach its workspace', () => {
    const cached: CachedDocument = {
      type: 'cached',
      id: 'c1',
      name: 'Saved for the flight',
      pageCount: 1,
      createdAt: 0,
      modifiedAt: 0,
      relayId: 'relay.example:443',
      workspaceId: 'ws-1',
      originalDocId: 'c1',
      cachedAt: 0,
      pendingChanges: 0,
      permission: 'owner',
    };
    render(<DocumentCard record={cached} mode="full" />);
    expect(screen.getAllByText('Offline')).toHaveLength(1);
  });
});
