/**
 * The document browser's View menu (JP-477, DSK-196): who owns sorting, and
 * what the phone-width header folds into the menu.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { BrowserViewMenu } from './BrowserViewMenu';

function setup(props: Partial<React.ComponentProps<typeof BrowserViewMenu>> = {}) {
  const setSort = vi.fn();
  const setGroupBy = vi.fn();
  render(
    <BrowserViewMenu
      columnSort={false}
      sort="modified-desc"
      setSort={setSort}
      groupBy="none"
      setGroupBy={setGroupBy}
      {...props}
    />,
  );
  return { setSort, setGroupBy };
}

describe('BrowserViewMenu', () => {
  beforeEach(() => cleanup());

  it('points at the column headers while they own sorting', () => {
    setup({ columnSort: true });
    fireEvent.click(screen.getByRole('button', { name: 'Sorting and grouping' }));
    const pointer = screen.getByRole('menuitem', { name: 'Click a column header to sort' });
    expect((pointer as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('menuitem', { name: 'Name (A–Z)' })).toBeNull();
  });

  it('sorts from the menu when there are no column headers (narrow list, or grid)', () => {
    const { setSort } = setup({ columnSort: false });
    fireEvent.click(screen.getByRole('button', { name: 'Sorting and grouping' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Name (A–Z)' }));
    expect(setSort).toHaveBeenCalledWith('name-asc');
  });

  describe('phone-width header (compact)', () => {
    function setupCompact() {
      const setView = vi.fn();
      const onRefresh = vi.fn();
      const handlers = setup({ compact: { view: 'list', setView, onRefresh } });
      fireEvent.click(screen.getByRole('button', { name: 'View options' }));
      return { setView, onRefresh, ...handlers };
    }

    it('holds the view toggle and Refresh', () => {
      const { setView, onRefresh } = setupCompact();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Grid' }));
      expect(setView).toHaveBeenCalledWith('grid');

      fireEvent.click(screen.getByRole('button', { name: 'View options' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh' }));
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('puts Sort and Group by behind pages that show the current choice', () => {
      const { setSort } = setupCompact();
      const sortRow = screen.getByRole('menuitem', { name: /Sort/ });
      expect(sortRow.textContent).toContain('Recently modified');
      expect(screen.getByRole('menuitem', { name: /Group by/ }).textContent).toContain('None');

      fireEvent.click(sortRow);
      fireEvent.click(screen.getByRole('menuitem', { name: 'Largest first' }));
      expect(setSort).toHaveBeenCalledWith('size-desc');
    });

    it('says when grouping is on, since the icon trigger has no label to say it', () => {
      setup({ groupBy: 'collection', compact: { view: 'list', setView: vi.fn(), onRefresh: vi.fn() } });
      expect(screen.getByRole('button', { name: 'View options (grouped by collection)' })).toBeTruthy();
    });
  });
});
