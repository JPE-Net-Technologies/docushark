/**
 * DocumentCard actions (JP-385 facelift): two visible quick actions
 * (contextual transfer + Trash) and an overflow menu holding the rest.
 * Pins the delete policy split — soft delete is one click (the model owns
 * confirm/Undo policy), permanent delete always routes through the styled
 * danger confirm — and that the overflow renders only granted actions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { DocumentCard } from './DocumentCard';
import { confirmDialog } from './confirm/confirmStore';
import type { LocalDocument } from '../types/DocumentRegistry';

vi.mock('./confirm/confirmStore', () => ({
  confirmDialog: vi.fn(),
}));

const confirmMock = vi.mocked(confirmDialog);

const record: LocalDocument = {
  type: 'local',
  id: 'l1',
  name: 'My Doc',
  pageCount: 1,
  createdAt: 0,
  modifiedAt: 0,
};

function openOverflow() {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
}

describe('DocumentCard — actions', () => {
  beforeEach(() => {
    cleanup();
    confirmMock.mockReset();
  });

  it('soft delete is a single click with no inline confirm UI', () => {
    const onDelete = vi.fn();
    render(<DocumentCard record={record} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));

    expect(onDelete).toHaveBeenCalledWith('l1');
    expect(confirmMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete?')).toBeNull(); // old 3-state confirm is gone
  });

  it('permanent delete goes through the danger confirm and only fires on OK', async () => {
    const onPermanentDelete = vi.fn();
    confirmMock.mockResolvedValueOnce(false);
    render(<DocumentCard record={record} onPermanentDelete={onPermanentDelete} />);

    openOverflow();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete permanently…' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
    expect(onPermanentDelete).not.toHaveBeenCalled();

    confirmMock.mockResolvedValueOnce(true);
    openOverflow();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete permanently…' }));
    await waitFor(() => expect(onPermanentDelete).toHaveBeenCalledWith('l1'));
  });

  it('renders only granted actions in the overflow menu', () => {
    render(<DocumentCard record={record} onRename={vi.fn()} onDelete={vi.fn()} />);

    openOverflow();
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Move to Trash' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Version history' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Manage access' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete permanently…' })).toBeNull();
  });

  it('Rename in the overflow switches the name to an inline input', () => {
    render(<DocumentCard record={record} onRename={vi.fn()} />);

    openOverflow();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

    expect(screen.getByDisplayValue('My Doc')).toBeTruthy();
  });

  it('keeps the contextual transfer action as a visible quick action', () => {
    const onPublishToTeam = vi.fn();
    render(<DocumentCard record={record} onPublishToTeam={onPublishToTeam} />);

    fireEvent.click(screen.getByRole('button', { name: 'Move to relay' }));
    expect(onPublishToTeam).toHaveBeenCalledWith('l1');
  });
});
