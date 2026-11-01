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
 * Narrow screens have no column headers (DSK-196), so there the menu sorts in
 * both views.
 *
 * On a phone-width header (DSK-196) the menu is also where the list/grid
 * toggle and Refresh live, behind an icon trigger: there is no room for them
 * as buttons. Sort and Group become pages, which keeps the menu short enough to
 * open as a sheet without scrolling.
 */

import {
  ArrowUpDown,
  ChevronDown,
  Group,
  LayoutGrid,
  List,
  RefreshCw,
  SlidersHorizontal,
} from 'lucide-react';
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

/** What the phone-width header folds into the menu. */
export interface BrowserViewMenuCompact {
  view: DocumentBrowserView;
  setView: (view: DocumentBrowserView) => void;
  onRefresh: () => void;
}

export interface BrowserViewMenuProps {
  /**
   * The list's column headers are on screen and own sorting, so the menu
   * points at them instead of offering a second sort control.
   */
  columnSort: boolean;
  sort: DocumentBrowserSort;
  setSort: (sort: DocumentBrowserSort) => void;
  groupBy: DocumentBrowserGroupBy;
  setGroupBy: (groupBy: DocumentBrowserGroupBy) => void;
  /** Phone-width header: an icon trigger, and the view toggle and Refresh inside. */
  compact?: BrowserViewMenuCompact | undefined;
}

const GROUP_LABELS: Record<DocumentBrowserGroupBy, string> = {
  none: 'None',
  collection: 'Collection',
};

export function BrowserViewMenu({
  columnSort,
  sort,
  setSort,
  groupBy,
  setGroupBy,
  compact,
}: BrowserViewMenuProps) {
  const sortEntries: DropdownMenuEntry[] = [];
  if (columnSort) {
    // Sorting is the column headers' job here. Offering a duplicate control
    // would leave two places to change one thing.
    sortEntries.push(
      menuAction({
        id: 'sort-columns',
        label: 'Click a column header to sort',
        disabled: true,
        onSelect: () => {},
      }),
    );
  } else {
    for (const [value, label] of Object.entries(SORT_LABELS)) {
      sortEntries.push(
        menuAction({
          id: `sort-${value}`,
          label,
          checked: sort === value,
          onSelect: () => setSort(value as DocumentBrowserSort),
        }),
      );
    }
  }

  const groupEntries: DropdownMenuEntry[] = (['none', 'collection'] as const).map((value) =>
    menuAction({
      id: `group-${value}`,
      label: GROUP_LABELS[value],
      checked: groupBy === value,
      onSelect: () => setGroupBy(value),
    }),
  );

  const groupActive = groupBy === 'collection';

  if (compact) {
    const entries: DropdownMenuEntry[] = [
      menuHeading('Show as'),
      menuAction({
        id: 'view-list',
        label: 'List',
        icon: <List size={16} aria-hidden="true" />,
        checked: compact.view === 'list',
        onSelect: () => compact.setView('list'),
      }),
      menuAction({
        id: 'view-grid',
        label: 'Grid',
        icon: <LayoutGrid size={16} aria-hidden="true" />,
        checked: compact.view === 'grid',
        onSelect: () => compact.setView('grid'),
      }),
      MENU_SEPARATOR,
      {
        kind: 'submenu',
        id: 'sort',
        label: 'Sort',
        detail: SORT_LABELS[sort],
        icon: <ArrowUpDown size={16} aria-hidden="true" />,
        entries: sortEntries,
      },
      {
        kind: 'submenu',
        id: 'group',
        label: 'Group by',
        detail: GROUP_LABELS[groupBy],
        icon: <Group size={16} aria-hidden="true" />,
        entries: groupEntries,
      },
      MENU_SEPARATOR,
      menuAction({
        id: 'refresh',
        label: 'Refresh',
        icon: <RefreshCw size={16} aria-hidden="true" />,
        onSelect: compact.onRefresh,
      }),
    ];
    return (
      <DropdownMenu
        trigger={<SlidersHorizontal size={18} aria-hidden="true" />}
        triggerClassName={`dh-viewmenu dh-viewmenu--icon${groupActive ? ' dh-viewmenu--active' : ''}`}
        triggerTitle={groupActive ? 'View options (grouped by collection)' : 'View options'}
        sheetTitle="View options"
        entries={entries}
        align="right"
      />
    );
  }

  const entries: DropdownMenuEntry[] = [
    menuHeading('Sort'),
    ...sortEntries,
    MENU_SEPARATOR,
    menuHeading('Group by'),
    ...groupEntries,
  ];

  // The trigger reports the active grouping, so the one non-default state a
  // user can forget about is visible without opening the menu.
  const activeHint = groupActive ? 'Collections' : 'View';

  return (
    <DropdownMenu
      trigger={
        <>
          <SlidersHorizontal size={16} aria-hidden="true" />
          <span className="dh-viewmenu-label">{activeHint}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </>
      }
      triggerClassName={`dh-viewmenu${groupActive ? ' dh-viewmenu--active' : ''}`}
      triggerTitle="Sorting and grouping"
      entries={entries}
      align="right"
    />
  );
}

export default BrowserViewMenu;
