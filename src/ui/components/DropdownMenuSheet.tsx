/**
 * DropdownMenuSheet — a DropdownMenu's entries as a bottom action sheet
 * (DSK-196).
 *
 * On a phone a 32px-row dropdown anchored to a 30px trigger is hard to hit,
 * and its submenus fly out sideways off a 375px screen. The same entries render
 * here as full-width 48px rows in a `MobileSheet` rising from the bottom edge;
 * a submenu becomes a second page with a back control, at the one level of
 * nesting the dropdown itself supports.
 *
 * Rendered only by `DropdownMenu`, which decides when a sheet replaces the
 * panel and owns open/close and selection.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { MobileSheet } from '../mobile/MobileSheet';
import type { DropdownMenuAction, DropdownMenuEntry } from './DropdownMenu';
import './DropdownMenuSheet.css';

export interface DropdownMenuSheetProps {
  title: string;
  subtitle?: string | undefined;
  entries: DropdownMenuEntry[];
  /** Fires the action and closes (the menu's own selection path). */
  onSelect: (action: DropdownMenuAction) => void;
  onClose: () => void;
}

interface SubmenuPage {
  id: string;
  label: string;
  entries: DropdownMenuEntry[];
}

/** Does this entry draw something in the leading slot (an icon or a swatch)? */
function hasLeading(entry: DropdownMenuEntry): boolean {
  if (entry.kind === 'action') return Boolean(entry.action.icon) || entry.action.swatchColor !== undefined;
  return entry.kind === 'submenu' && Boolean(entry.icon);
}

function sheetItems(list: HTMLElement | null): HTMLButtonElement[] {
  if (!list) return [];
  return Array.from(list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
}

export function DropdownMenuSheet({ title, subtitle, entries, onSelect, onClose }: DropdownMenuSheetProps) {
  const [page, setPage] = useState<SubmenuPage | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The row that opened the current page, so Back returns focus to it.
  const returnFocusId = useRef<string | null>(null);

  // Keyboard users land on the first row of each page. A touch tap that
  // opened the sheet doesn't match :focus-visible, so no ring flashes on touch.
  useEffect(() => {
    const items = sheetItems(listRef.current);
    const back = returnFocusId.current;
    const target = !page && back ? items.find((el) => el.dataset['entryId'] === back) : items[0];
    target?.focus({ preventScroll: true });
    if (!page) returnFocusId.current = null;
  }, [page]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = sheetItems(listRef.current);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = current === -1 ? 0 : (current + 1) % items.length;
    else if (e.key === 'ArrowUp') next = current === -1 ? items.length - 1 : (current - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowLeft' && page) {
      e.preventDefault();
      setPage(null);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus({ preventScroll: true });
  };

  // When any row in a list leads with an icon or swatch, a row without one
  // keeps the slot empty, so every label starts on the same line.
  const renderAction = (action: DropdownMenuAction, alignLabels: boolean) => (
    <button
      key={action.id}
      type="button"
      role="menuitem"
      data-entry-id={action.id}
      className={`dropdown-sheet__item${action.danger ? ' dropdown-sheet__item--danger' : ''}`}
      disabled={action.disabled}
      onClick={() => onSelect(action)}
    >
      {action.swatchColor !== undefined && (
        <span
          className="dropdown-sheet__swatch"
          style={action.swatchColor ? { background: action.swatchColor } : undefined}
        />
      )}
      {action.icon && <span className="dropdown-sheet__icon">{action.icon}</span>}
      {alignLabels && !action.icon && action.swatchColor === undefined && (
        <span className="dropdown-sheet__icon dropdown-sheet__icon--empty" aria-hidden="true" />
      )}
      <span className="dropdown-sheet__label">{action.label}</span>
      {action.checked && <Check className="dropdown-sheet__check" size={18} aria-hidden="true" />}
    </button>
  );

  const renderEntries = (
    list: DropdownMenuEntry[],
    nested: boolean,
    alignLabels = list.some(hasLeading),
  ): ReactNode[] =>
    list.map((entry, i): ReactNode => {
      if (entry.kind === 'separator') {
        return <div key={`sep-${i}`} className="dropdown-sheet__separator" role="separator" />;
      }
      if (entry.kind === 'heading') {
        return (
          <div key={`head-${i}`} className="dropdown-sheet__heading" role="presentation">
            {entry.label}
          </div>
        );
      }
      if (entry.kind === 'action') return renderAction(entry.action, alignLabels);
      // One level of pages, like the dropdown's one level of flyouts: a
      // submenu inside a submenu renders its actions inline.
      if (nested) return renderEntries(entry.entries, true, alignLabels);
      return (
        <button
          key={entry.id}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          data-entry-id={entry.id}
          className="dropdown-sheet__item dropdown-sheet__item--submenu"
          onClick={() => {
            returnFocusId.current = entry.id;
            setPage({ id: entry.id, label: entry.label, entries: entry.entries });
          }}
        >
          {entry.icon && <span className="dropdown-sheet__icon">{entry.icon}</span>}
          {alignLabels && !entry.icon && (
            <span className="dropdown-sheet__icon dropdown-sheet__icon--empty" aria-hidden="true" />
          )}
          <span className="dropdown-sheet__label">{entry.label}</span>
          {entry.detail && <span className="dropdown-sheet__detail">{entry.detail}</span>}
          <ChevronRight className="dropdown-sheet__chevron" size={18} aria-hidden="true" />
        </button>
      );
    });

  return (
    <MobileSheet
      placement="bottom"
      title={page ? page.label : title}
      subtitle={page ? title : subtitle}
      onBack={page ? () => setPage(null) : undefined}
      onClose={onClose}
      className="dropdown-sheet"
    >
      <div
        ref={listRef}
        className="dropdown-sheet__list"
        role="menu"
        aria-label={page ? page.label : title}
        onKeyDown={onKeyDown}
      >
        {renderEntries(page ? page.entries : entries, page !== null)}
      </div>
    </MobileSheet>
  );
}
