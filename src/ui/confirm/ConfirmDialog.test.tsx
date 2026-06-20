import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ConfirmDialogHost } from './ConfirmDialog';
import { confirmDialog, useConfirmStore } from './confirmStore';

describe('ConfirmDialogHost', () => {
  beforeEach(() => {
    cleanup();
    useConfirmStore.setState({ current: null, queue: [] });
  });

  it('renders nothing when idle', () => {
    const { container } = render(<ConfirmDialogHost />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('shows the active prompt (title, message, details) and resolves true on confirm', async () => {
    render(<ConfirmDialogHost />);
    const p = confirmDialog({
      title: 'Delete 3 documents?',
      message: 'They’ll be moved to Trash.',
      details: 'Cloud documents are removed from the workspace.',
      confirmLabel: 'Delete',
      danger: true,
    });

    expect(await screen.findByText('Delete 3 documents?')).toBeTruthy();
    expect(screen.getByText('They’ll be moved to Trash.')).toBeTruthy();
    expect(screen.getByText('Cloud documents are removed from the workspace.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await expect(p).resolves.toBe(true);
  });

  it('resolves false on Cancel', async () => {
    render(<ConfirmDialogHost />);
    const p = confirmDialog({ title: 'Question?' });
    await screen.findByText('Question?');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(p).resolves.toBe(false);
  });

  it('resolves false on Escape', async () => {
    render(<ConfirmDialogHost />);
    const p = confirmDialog({ title: 'Escape me' });
    await screen.findByText('Escape me');

    fireEvent.keyDown(document, { key: 'Escape' });
    await expect(p).resolves.toBe(false);
  });

  it('uses the default labels when none are given', async () => {
    render(<ConfirmDialogHost />);
    void confirmDialog({ title: 'Defaults' });
    await screen.findByText('Defaults');

    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });
});
