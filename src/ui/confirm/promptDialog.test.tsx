import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ConfirmDialogHost } from './ConfirmDialog';
import { promptDialog, confirmDialog, useConfirmStore } from './confirmStore';

describe('promptDialog', () => {
  beforeEach(() => {
    cleanup();
    useConfirmStore.setState({ current: null, queue: [] });
  });

  it('resolves the typed value on submit', async () => {
    render(<ConfirmDialogHost />);
    const p = promptDialog({ title: 'New collection', confirmLabel: 'Create' });

    const input = (await screen.findByRole('textbox')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  Roadmap  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    // Trimmed.
    await expect(p).resolves.toBe('Roadmap');
  });

  it('pre-fills initialValue (rename) and resolves the edited value', async () => {
    render(<ConfirmDialogHost />);
    const p = promptDialog({ title: 'Rename collection', initialValue: 'Old name' });

    const input = (await screen.findByDisplayValue('Old name')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.submit(input.closest('form')!);

    await expect(p).resolves.toBe('New name');
  });

  it('resolves null on Cancel', async () => {
    render(<ConfirmDialogHost />);
    const p = promptDialog({ title: 'New collection' });
    await screen.findByRole('textbox');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(p).resolves.toBeNull();
  });

  it('resolves null on Escape', async () => {
    render(<ConfirmDialogHost />);
    const p = promptDialog({ title: 'New collection' });
    await screen.findByRole('textbox');

    fireEvent.keyDown(document, { key: 'Escape' });
    await expect(p).resolves.toBeNull();
  });

  it('disables confirm and does not resolve on empty/whitespace input', async () => {
    render(<ConfirmDialogHost />);
    promptDialog({ title: 'New collection', confirmLabel: 'Create' });
    const input = (await screen.findByRole('textbox')) as HTMLInputElement;

    // Empty initial value → confirm disabled.
    const create = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    // Whitespace stays disabled.
    fireEvent.change(input, { target: { value: '   ' } });
    expect(create.disabled).toBe(true);
  });

  it('queues behind a confirm dialog, then shows the prompt', async () => {
    render(<ConfirmDialogHost />);
    const c = confirmDialog({ title: 'First confirm' });
    promptDialog({ title: 'Second prompt' });

    // Only the first is visible.
    await screen.findByText('First confirm');
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(c).resolves.toBe(false);

    // Now the queued prompt surfaces (its title + text input).
    expect(await screen.findByText('Second prompt')).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
});
