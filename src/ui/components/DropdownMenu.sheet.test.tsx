/**
 * DropdownMenu as a bottom action sheet (DSK-196). On a phone every menu opens
 * as a sheet: the same entries as 48px rows, a submenu as a second page, and no
 * click inside it reaching the card (or anything else) it was opened from.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

const h = vi.hoisted(() => ({ mobile: true }));
vi.mock('../layout/useMobileAdaptation', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../layout/useMobileAdaptation')>();
  return { ...mod, readMobileActive: () => h.mobile };
});

import { DropdownMenu, menuAction, MENU_SEPARATOR, type DropdownMenuEntry } from './DropdownMenu';

function entries(onRename = vi.fn(), onPick = vi.fn()): DropdownMenuEntry[] {
  return [
    menuAction({ id: 'rename', label: 'Rename', onSelect: onRename }),
    {
      kind: 'submenu',
      id: 'collection',
      label: 'Move to collection',
      detail: 'Specs',
      entries: [
        menuAction({ id: 'specs', label: 'Specs', swatchColor: '#3b82f6', checked: true, onSelect: onPick }),
        menuAction({ id: 'research', label: 'Research', swatchColor: null, onSelect: onPick }),
      ],
    },
    MENU_SEPARATOR,
    menuAction({ id: 'trash', label: 'Move to Trash', danger: true, onSelect: vi.fn() }),
  ];
}

function renderMenu(list: DropdownMenuEntry[], extra: Partial<React.ComponentProps<typeof DropdownMenu>> = {}) {
  const onCardClick = vi.fn();
  const onCardDoubleClick = vi.fn();
  const utils = render(
    // The card a menu lives on opens on click and renames on double-click.
    <div onClick={onCardClick} onDoubleClick={onCardDoubleClick}>
      <DropdownMenu
        trigger={<span>More</span>}
        triggerTitle="More actions"
        sheetTitle="Quarterly plan"
        sheetSubtitle="Cloud · Edited 3h ago"
        entries={list}
        {...extra}
      />
    </div>,
  );
  return { onCardClick, onCardDoubleClick, ...utils };
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
}

describe('DropdownMenu — action sheet on a phone (DSK-196)', () => {
  beforeEach(() => {
    cleanup();
    h.mobile = true;
  });

  it('opens as a sheet titled with what it acts on, not as the anchored panel', () => {
    renderMenu(entries());
    openMenu();
    const sheet = screen.getByRole('dialog', { name: 'Quarterly plan' });
    expect(within(sheet).getByText('Cloud · Edited 3h ago')).toBeTruthy();
    expect(within(sheet).getByRole('menuitem', { name: 'Rename' })).toBeTruthy();
    expect(document.querySelector('.dropdown-menu__panel')).toBeNull();
  });

  it('uses the anchored panel when the mobile chrome is off', () => {
    h.mobile = false;
    renderMenu(entries());
    openMenu();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('.dropdown-menu__panel')).not.toBeNull();
  });

  it('never turns a hover menu into a sheet', () => {
    renderMenu(entries(), { openOnHover: true });
    openMenu();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('fires the action and closes', () => {
    const onRename = vi.fn();
    renderMenu(entries(onRename));
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a submenu as a second page, and Back returns to the first', () => {
    const onPick = vi.fn();
    renderMenu(entries(vi.fn(), onPick));
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Move to collection/ }));

    const page = screen.getByRole('dialog', { name: 'Move to collection' });
    // The page names what it belongs to.
    expect(within(page).getByText('Quarterly plan')).toBeTruthy();
    expect(within(page).queryByRole('menuitem', { name: 'Rename' })).toBeNull();

    fireEvent.click(within(page).getByRole('button', { name: 'Back' }));
    const first = screen.getByRole('dialog', { name: 'Quarterly plan' });
    expect(document.activeElement).toBe(within(first).getByRole('menuitem', { name: /Move to collection/ }));

    fireEvent.click(screen.getByRole('menuitem', { name: /Move to collection/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Research' }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes from the scrim and the close button, and on Escape returns focus to the trigger', () => {
    const { container } = renderMenu(entries());
    openMenu();
    fireEvent.click(document.querySelector('.mobile-sheet-scrim') as Element);
    expect(screen.queryByRole('dialog')).toBeNull();

    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    openMenu();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(within(container).getByRole('button', { name: 'More actions' }));
  });

  it('keeps taps inside the sheet from reaching the card underneath', () => {
    const { onCardClick, onCardDoubleClick } = renderMenu(entries());
    openMenu();
    onCardClick.mockClear(); // the trigger stops its own click; be explicit anyway

    fireEvent.click(screen.getByText('Cloud · Edited 3h ago'));
    fireEvent.doubleClick(screen.getByText('Cloud · Edited 3h ago'));
    fireEvent.click(document.querySelector('.mobile-sheet-scrim') as Element);

    expect(onCardClick).not.toHaveBeenCalled();
    expect(onCardDoubleClick).not.toHaveBeenCalled();
  });

  it('does not close on the outside-click path the panel uses', () => {
    renderMenu(entries());
    openMenu();
    // The sheet is portaled outside the trigger; a mousedown inside it is not
    // an outside click.
    fireEvent.mouseDown(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(screen.getByRole('dialog', { name: 'Quarterly plan' })).toBeTruthy();
  });

  it('leaves focus on the sheet when a tap opened it, so no row is ringed (DSK-197)', () => {
    renderMenu(entries());
    // A pointer click carries a click count; a keyboard activation doesn't.
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }), { detail: 1 });
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Quarterly plan' }));
  });

  it('starts on the first row when the keyboard opened it', () => {
    renderMenu(entries());
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }), { detail: 0 });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }));
  });

  it('shows a submenu’s current choice on its row', () => {
    renderMenu(entries());
    openMenu();
    expect(screen.getByRole('menuitem', { name: /Move to collection/ }).textContent).toContain('Specs');
  });
});
