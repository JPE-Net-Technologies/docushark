/**
 * CollectionActionsMenu as a sheet on a phone (DSK-196). Each choice closes
 * the sheet before its action runs: Rename and Delete open dialogs, and a
 * sheet left open on the dropdown layer would hide them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({ mobile: true }));
vi.mock('../layout/useMobileAdaptation', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../layout/useMobileAdaptation')>();
  return { ...mod, readMobileActive: () => h.mobile };
});

import { CollectionActionsMenu } from './CollectionActionsMenu';
import type { Collection } from '../../store/collectionStore';

const specs = { id: 'c1', name: 'Specs', color: '#3b82f6' } as Collection;

function setup() {
  const calls: string[] = [];
  const onClose = vi.fn(() => calls.push('close'));
  const onRename = vi.fn(() => calls.push('rename'));
  const onDelete = vi.fn(() => calls.push('delete'));
  const onRecolor = vi.fn(() => calls.push('recolor'));
  render(
    <CollectionActionsMenu
      collection={specs}
      isOpen
      onOpen={vi.fn()}
      onClose={onClose}
      onRename={onRename}
      onDelete={onDelete}
      onRecolor={onRecolor}
    />,
  );
  return { calls, onClose, onRename, onDelete, onRecolor };
}

describe('CollectionActionsMenu on a phone (DSK-196)', () => {
  beforeEach(() => {
    cleanup();
    h.mobile = true;
  });

  it('opens as a sheet named for the collection, with its colour marked', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Specs' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Blue' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'No colour' }).getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.document-browser__section-menu')).toBeNull();
  });

  it('closes before Rename opens its dialog', () => {
    const { calls, onRename } = setup();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    expect(onRename).toHaveBeenCalledWith(specs);
    expect(calls).toEqual(['close', 'rename']);
  });

  it('closes before Delete opens its confirmation', () => {
    const { calls } = setup();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete collection…' }));
    expect(calls).toEqual(['close', 'delete']);
  });

  it('recolours, and clears the colour', () => {
    const { onRecolor } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Pink' }));
    expect(onRecolor).toHaveBeenLastCalledWith(specs, '#ec4899');
    fireEvent.click(screen.getByRole('button', { name: 'No colour' }));
    expect(onRecolor).toHaveBeenLastCalledWith(specs, undefined);
  });

  it('is not closed by a tap inside it (the popup’s outside-click rule)', () => {
    const { onClose } = setup();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Pink' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the anchored popup when the mobile chrome is off', () => {
    h.mobile = false;
    setup();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('.document-browser__section-menu')).not.toBeNull();
  });
});
