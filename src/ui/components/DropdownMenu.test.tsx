/**
 * DropdownMenu — shared portal menu primitive (JP-385). Pins the interaction
 * contract every consumer (card kebab, selection bar) relies on: entries
 * render as menuitems, selection fires-and-closes, disabled items are inert,
 * Escape closes and restores trigger focus, and submenus open/close.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DropdownMenu, menuAction, MENU_SEPARATOR, type DropdownMenuEntry } from './DropdownMenu';

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
}

function renderMenu(entries: DropdownMenuEntry[], onOpenChange?: (open: boolean) => void) {
  return render(
    <DropdownMenu
      trigger={<span>Menu</span>}
      triggerTitle="Menu"
      entries={entries}
      onOpenChange={onOpenChange}
    />,
  );
}

describe('DropdownMenu', () => {
  beforeEach(() => cleanup());

  it('renders entries only after the trigger is clicked', () => {
    renderMenu([menuAction({ id: 'a', label: 'Alpha', onSelect: vi.fn() })]);
    expect(screen.queryByRole('menu')).toBeNull();
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toBeTruthy();
  });

  it('fires onSelect and closes on action click', () => {
    const onSelect = vi.fn();
    renderMenu([menuAction({ id: 'a', label: 'Alpha', onSelect })]);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('does not fire disabled actions', () => {
    const onSelect = vi.fn();
    renderMenu([menuAction({ id: 'a', label: 'Alpha', disabled: true, onSelect })]);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }));
    expect(onSelect).not.toHaveBeenCalled();
    // A disabled item is not a selection — the menu stays open.
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    renderMenu([menuAction({ id: 'a', label: 'Alpha', onSelect: vi.fn() })]);
    openMenu();
    const item = screen.getByRole('menuitem', { name: 'Alpha' });
    expect(document.activeElement).toBe(item); // first item auto-focused
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Menu' }));
  });

  it('moves focus with ArrowDown/ArrowUp, skipping disabled items', () => {
    renderMenu([
      menuAction({ id: 'a', label: 'Alpha', onSelect: vi.fn() }),
      menuAction({ id: 'b', label: 'Bravo', disabled: true, onSelect: vi.fn() }),
      menuAction({ id: 'c', label: 'Charlie', onSelect: vi.fn() }),
    ]);
    openMenu();
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Charlie' }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' }); // wraps past the end
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Alpha' }));
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Charlie' }));
  });

  it('renders separators and opens submenus', () => {
    const onSelect = vi.fn();
    renderMenu([
      menuAction({ id: 'a', label: 'Alpha', onSelect: vi.fn() }),
      MENU_SEPARATOR,
      {
        kind: 'submenu',
        id: 'sub',
        label: 'More…',
        entries: [menuAction({ id: 'n', label: 'Nested', onSelect })],
      },
    ]);
    openMenu();
    expect(screen.getByRole('separator')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Nested' })).toBeNull();

    fireEvent.click(screen.getByRole('menuitem', { name: 'More…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Nested' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull(); // whole menu closed
  });

  it('re-hovering the open submenu trigger keeps the submenu visible (no placement reset)', () => {
    renderMenu([
      {
        kind: 'submenu',
        id: 'sub',
        label: 'More…',
        entries: [menuAction({ id: 'n', label: 'Nested', onSelect: vi.fn() })],
      },
    ]);
    openMenu();
    const trigger = screen.getByRole('menuitem', { name: 'More…' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'Nested' })).toBeTruthy();

    // The regression: mouseenter on the already-open trigger reset the
    // placement (hiding the panel) without re-running the placement effect.
    fireEvent.mouseEnter(trigger);
    const nested = screen.getByRole('menuitem', { name: 'Nested' });
    const subPanel = nested.closest('.dropdown-menu__panel--sub') as HTMLElement;
    expect(subPanel).toBeTruthy();
    expect(getComputedStyle(subPanel).visibility).not.toBe('hidden');
  });

  it('reports open state through onOpenChange', () => {
    const onOpenChange = vi.fn();
    renderMenu([menuAction({ id: 'a', label: 'Alpha', onSelect: vi.fn() })], onOpenChange);
    openMenu();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('menu clicks do not bubble to the surface underneath', () => {
    const surfaceClick = vi.fn();
    render(
      <div onClick={surfaceClick}>
        <DropdownMenu
          trigger={<span>Menu</span>}
          triggerTitle="Menu"
          entries={[menuAction({ id: 'a', label: 'Alpha', onSelect: vi.fn() })]}
        />
      </div>,
    );
    openMenu();
    // Opening via the trigger must not click the surface (cards open on click)…
    expect(surfaceClick).not.toHaveBeenCalled();
    // …and neither must selecting an item (the panel is portaled anyway).
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }));
    expect(surfaceClick).not.toHaveBeenCalled();
  });
});
