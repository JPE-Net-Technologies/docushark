/**
 * BrowserViewMenu (JP-477) — the document browser's Sort + Group control.
 *
 * These were two bare `<select>` elements in the header. They were the only
 * un-designed chrome on the surface, they cost 337px of a 657px action row for
 * two low-frequency choices, and because the Sort select renders in grid view
 * only, toggling the view mode grew the header from one row to two — a layout
 * jump triggered by a control that has nothing to do with layout.
 *
 * One trigger of fixed width, present in both views, fixes all three. Sorting
 * in list view still belongs to the column headers (JP-444), so the menu says
 * so rather than offering a second control that silently disagrees with them.
 */

import { SlidersHorizontal, ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  menuAction,
  menuHeading,
  MENU_SEPARATOR,
  type DropdownMenuEntry,
} from '../components/DropdownMenu';
import { SORT_LABELS } from '../settings/useDocumentBrowserModel';
import type {
  DocumentBrowserGroupBy,
  DocumentBrowserSort,
  DocumentBrowserView,
} from '../../store/uiPreferencesStore';

export interface BrowserViewMenuProps {
  view: DocumentBrowserView;
  sort: DocumentBrowserSort;
  setSort: (sort: DocumentBrowserSort) => void;
  groupBy: DocumentBrowserGroupBy;
  setGroupBy: (groupBy: DocumentBrowserGroupBy) => void;
}

const GROUP_LABELS: Record<DocumentBrowserGroupBy, string> = {
  none: 'None',
  collection: 'Collection',
};

export function BrowserViewMenu({
  view,
  sort,
  setSort,
  groupBy,
  setGroupBy,
}: BrowserViewMenuProps) {
  const entries: DropdownMenuEntry[] = [menuHeading('Sort')];

  if (view === 'list') {
    // Sorting is the column headers' job here. Offering a duplicate control
    // would leave two places to change one thing.
    entries.push(
      menuAction({
        id: 'sort-columns',
        label: 'Click a column header to sort',
        disabled: true,
        onSelect: () => {},
      }),
    );
  } else {
    for (const [value, label] of Object.entries(SORT_LABELS)) {
      entries.push(
        menuAction({
          id: `sort-${value}`,
          label,
          checked: sort === value,
          onSelect: () => setSort(value as DocumentBrowserSort),
        }),
      );
    }
  }

  entries.push(MENU_SEPARATOR, menuHeading('Group by'));
  for (const value of ['none', 'collection'] as const) {
    entries.push(
      menuAction({
        id: `group-${value}`,
        label: GROUP_LABELS[value],
        checked: groupBy === value,
        onSelect: () => setGroupBy(value),
      }),
    );
  }

  // The trigger reports the active grouping, so the one non-default state a
  // user can forget about is visible without opening the menu.
  const activeHint = groupBy === 'collection' ? 'Collections' : 'View';

  return (
    <DropdownMenu
      trigger={
        <>
          <SlidersHorizontal size={16} aria-hidden="true" />
          <span className="dh-viewmenu-label">{activeHint}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </>
      }
      triggerClassName={`dh-viewmenu${groupBy === 'collection' ? ' dh-viewmenu--active' : ''}`}
      triggerTitle="Sorting and grouping"
      entries={entries}
      align="right"
    />
  );
}

export default BrowserViewMenu;
