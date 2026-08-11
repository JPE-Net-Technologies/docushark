/**
 * DropdownMenu — shared portal menu primitive (JP-385). Pins the interaction
 * contract every consumer (card kebab, selection bar) relies on: entries
 * render as menuitems, selection fires-and-closes, disabled items are inert,
 * Escape closes and restores trigger focus, and submenus open/close.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
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

  it('hovering items INSIDE the submenu never closes it; root siblings close it after a grace delay (JP-444)', () => {
    vi.useFakeTimers();
    try {
      renderMenu([
        menuAction({ id: 'a', label: 'Alpha', onSelect: vi.fn() }),
        {
          kind: 'submenu',
          id: 'sub',
          label: 'More…',
          entries: [menuAction({ id: 'n', label: 'Nested', onSelect: vi.fn() })],
        },
      ]);
      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'More…' }));
      const nested = screen.getByRole('menuitem', { name: 'Nested' });

      // The regression: every action carried the close-on-hover handler, so
      // hovering the submenu's own items closed the panel out from under the
      // pointer. Submenu items must be safe to hover indefinitely.
      fireEvent.mouseEnter(nested);
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByRole('menuitem', { name: 'Nested' })).toBeTruthy();

      // Clipping a ROOT sibling schedules the close (diagonal travel)…
      fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Alpha' }));
      // …but reaching the sub panel within the grace period cancels it.
      fireEvent.mouseEnter(
        nested.closest('.dropdown-menu__panel--sub') as HTMLElement,
      );
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByRole('menuitem', { name: 'Nested' })).toBeTruthy();

      // Genuinely resting on a root sibling still closes it after the delay.
      fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Alpha' }));
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.queryByRole('menuitem', { name: 'Nested' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

  /**
   * Context-menu mode: a controlled, trigger-less menu placed at a cursor
   * point. Every prop involved is additive and defaults off, so the suite
   * above doubles as the regression guard for existing consumers.
   */
  describe('controlled + anchorPoint (right-click menus)', () => {
    it('renders with no trigger button and opens from the `open` prop', () => {
      render(
        <DropdownMenu
          open
          anchorPoint={{ x: 40, y: 60 }}
          entries={[menuAction({ id: 'a', label: 'Alpha', onSelect: vi.fn() })]}
        />,
      );
      // No trigger was passed, so none should be rendered.
      expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
      expect(screen.getByRole('menuitem', { name: 'Alpha' })).toBeTruthy();
    });

    it('positions the panel at the anchor point rather than under a trigger', () => {
      render(
        <DropdownMenu
          open
          anchorPoint={{ x: 120, y: 200 }}
          entries={[menuAction({ id: 'a', label: 'Alpha', onSelect: vi.fn() })]}
        />,
      );
      const panel = screen.getByRole('menu') as HTMLElement;
      // jsdom reports zero-size elements, so the clamp leaves x untouched and
      // the panel opens down-right of the point (y + 4px offset).
      expect(panel.style.left).toBe('120px');
      expect(panel.style.top).toBe('204px');
    });

    it('a controlled parent is asked to close, and stays open until it agrees', () => {
      const onOpenChange = vi.fn();
      render(
        <DropdownMenu
          open
          anchorPoint={{ x: 10, y: 10 }}
          onOpenChange={onOpenChange}
          entries={[menuAction({ id: 'a', label: 'Alpha', onSelect: vi.fn() })]}
        />,
      );
      fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }));
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
      // `open` is still true from the parent, so the menu must not self-close —
      // that is what "controlled" means.
      expect(screen.getByRole('menu')).toBeTruthy();
    });
  });

  describe('openOnHover', () => {
    it('opens on pointer enter without stealing focus', () => {
      render(
        <DropdownMenu
          trigger={<span>Menu</span>}
          triggerTitle="Menu"
          openOnHover
          entries={[menuAction({ id: 'a', label: 'Alpha', onSelect: vi.fn() })]}
        />,
      );
      fireEvent.mouseEnter(screen.getByRole('button', { name: 'Menu' }));
      const item = screen.getByRole('menuitem', { name: 'Alpha' });
      expect(item).toBeTruthy();
      // Hover is pointer-driven: yanking focus out of whatever the user was
      // doing would be a bug, not a convenience.
      expect(document.activeElement).not.toBe(item);
    });

    it('survives the trip from trigger to the portaled panel', () => {
      vi.useFakeTimers();
      try {
        render(
          <DropdownMenu
            trigger={<span>Menu</span>}
            triggerTitle="Menu"
            openOnHover
            entries={[menuAction({ id: 'a', label: 'Alpha', onSelect: vi.fn() })]}
          />,
        );
        const trigger = screen.getByRole('button', { name: 'Menu' });
        fireEvent.mouseEnter(trigger);
        // Leaving the trigger starts the grace timer; the panel is portaled, so
        // this fires the instant the pointer sets off toward the menu.
        fireEvent.mouseLeave(trigger);
        fireEvent.mouseEnter(screen.getByRole('menu'));
        act(() => void vi.advanceTimersByTime(500));
        expect(screen.getByRole('menuitem', { name: 'Alpha' })).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it('closes once the pointer leaves the panel too', () => {
      vi.useFakeTimers();
      try {
        render(
          <DropdownMenu
            trigger={<span>Menu</span>}
            triggerTitle="Menu"
            openOnHover
            entries={[menuAction({ id: 'a', label: 'Alpha', onSelect: vi.fn() })]}
          />,
        );
        fireEvent.mouseEnter(screen.getByRole('button', { name: 'Menu' }));
        fireEvent.mouseLeave(screen.getByRole('menu'));
        act(() => void vi.advanceTimersByTime(500));
        expect(screen.queryByRole('menu')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a click still focuses the first item (keyboard-equivalent intent)', () => {
      render(
        <DropdownMenu
          trigger={<span>Menu</span>}
          triggerTitle="Menu"
          openOnHover
          entries={[menuAction({ id: 'a', label: 'Alpha', onSelect: vi.fn() })]}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Alpha' }));
    });
  });
});
