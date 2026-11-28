/**
 * A page's menu (DSK-260).
 *
 * One description of a page's actions, whichever way it's opened: a
 * right-click, the ⋯ on its tab, press and hold, or Shift+F10 on a focused
 * tab. The page strips and the Navigator build it here, so they can't drift
 * apart. On a phone it opens as a sheet headed by the page's name and facts.
 */

import { DropdownMenu, MENU_SEPARATOR, menuAction, menuHeading, type DropdownMenuEntry } from '../components/DropdownMenu';
import { providerLabel, useIntegrationHubStore } from '../../store/integrationHubStore';
import {
  detachMirrorPageWithConfirm,
  openMirrorSource,
  refreshMirrorPageWithFeedback,
} from '../../services/mirrorPageActions';
import type { PageMirrorMeta } from '../../types/PageMirror';

/** The colors a writing page's tab can take. */
export const PAGE_COLORS: readonly { name: string; value: string }[] = [
  { name: 'Red', value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Yellow', value: '#eab308' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Cyan', value: '#06b6d4' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Violet', value: '#8b5cf6' },
  { name: 'Pink', value: '#ec4899' },
  { name: 'Gray', value: '#6b7280' },
];

/** A mirrored page's source actions, the same wherever the page is listed. */
export function mirrorPageMenuEntries(
  pageId: string,
  mirror: PageMirrorMeta,
  onAddSubpages: () => void,
): DropdownMenuEntry[] {
  const source = providerLabel(useIntegrationHubStore.getState().hub, mirror.provider);
  const url = mirror.url;
  return [
    menuAction({ id: 'refresh', label: 'Refresh from source', onSelect: () => void refreshMirrorPageWithFeedback(pageId) }),
    menuAction({ id: 'ingest', label: 'Add subpages…', onSelect: onAddSubpages }),
    ...(url ? [menuAction({ id: 'open-external', label: `Open in ${source}`, onSelect: () => openMirrorSource(url) })] : []),
    menuAction({ id: 'detach', label: `Detach from ${source}`, onSelect: () => void detachMirrorPageWithConfirm(pageId, source) }),
  ];
}

export interface PageMenuOptions {
  /** The page's facts as one line, heading the menu where there's no hover card (touch). */
  heading?: string | undefined;
  /** Absent where the page can't be renamed: a mirror (it follows its source) or a view-only document. */
  onRename?: (() => void) | undefined;
  /** Writing pages only: diagram pages have no color. */
  color?: { current: string | undefined; onPick: (color: string | undefined) => void } | undefined;
  onDuplicate?: (() => void) | undefined;
  /** A mirror page's source actions ({@link mirrorPageMenuEntries}). */
  mirror?: DropdownMenuEntry[] | undefined;
  /** Absent in a view-only document. */
  onDelete?: (() => void) | undefined;
  /** False for the last page of its kind on show: Delete is shown but unavailable. */
  canDelete: boolean;
}

export function pageMenuEntries(options: PageMenuOptions): DropdownMenuEntry[] {
  const entries: DropdownMenuEntry[] = [];
  if (options.heading) entries.push(menuHeading(options.heading));
  if (options.onRename) entries.push(menuAction({ id: 'rename', label: 'Rename', onSelect: options.onRename }));
  if (options.color) {
    const { current, onPick } = options.color;
    entries.push({
      kind: 'submenu',
      id: 'color',
      label: 'Color',
      detail: PAGE_COLORS.find((c) => c.value === current)?.name,
      entries: [
        ...PAGE_COLORS.map((c) =>
          menuAction({
            id: `color-${c.name.toLowerCase()}`,
            label: c.name,
            swatchColor: c.value,
            checked: c.value === current,
            onSelect: () => onPick(c.value),
          }),
        ),
        MENU_SEPARATOR,
        menuAction({ id: 'color-none', label: 'No color', swatchColor: null, checked: current === undefined, onSelect: () => onPick(undefined) }),
      ],
    });
  }
  if (options.onDuplicate) entries.push(menuAction({ id: 'duplicate', label: 'Duplicate', onSelect: options.onDuplicate }));
  if (options.mirror && options.mirror.length > 0) entries.push(MENU_SEPARATOR, ...options.mirror);
  if (options.onDelete) {
    entries.push(
      MENU_SEPARATOR,
      menuAction({ id: 'delete', label: 'Delete page', danger: true, disabled: !options.canDelete, onSelect: options.onDelete }),
    );
  }
  return entries;
}

/** Where a page's menu opens: the page, and a viewport point. */
export interface PageMenuAnchor {
  pageId: string;
  x: number;
  y: number;
}

interface PageMenuProps {
  anchor: PageMenuAnchor | null;
  entries: DropdownMenuEntry[];
  /** The page's name: what a phone's sheet is titled. */
  title: string;
  /** The page's facts, under the sheet's title. */
  subtitle?: string | undefined;
  onClose: () => void;
}

/** A page's menu at a point, or as a sheet on a phone. */
export function PageMenu({ anchor, entries, title, subtitle, onClose }: PageMenuProps) {
  return (
    <DropdownMenu
      open={anchor !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      anchorPoint={anchor}
      entries={entries}
      sheetTitle={title}
      sheetSubtitle={subtitle}
    />
  );
}
