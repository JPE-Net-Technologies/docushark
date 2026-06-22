import { useCallback, useRef, useState, type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import './RichSelect.css';

/**
 * One entry in a {@link RichSelect}. `render` lets an entry draw itself richly
 * (e.g. a heading option styled as an actual H1); `label` is the plain-text
 * fallback shown in the trigger and used for keyboard type-ahead.
 */
export interface RichSelectItem<T extends string> {
  value: T;
  label: string;
  /** Rich content for the option row. Falls back to `label` when omitted. */
  render?: (active: boolean) => ReactNode;
  /** Type-ahead text (defaults to `label`). */
  keywords?: string;
}

export interface RichSelectProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  items: RichSelectItem<T>[];
  /** Custom trigger content; defaults to the current item's label + a chevron. */
  trigger?: ReactNode;
  /** Opportunistically open on hover (default off). Click/keyboard always work. */
  hoverOpen?: boolean;
  align?: 'start' | 'center' | 'end';
  ariaLabel?: string;
  /** Extra class on the trigger button. */
  className?: string;
  minWidth?: number;
}

const HOVER_CLOSE_DELAY_MS = 200;

/**
 * A reusable, accessible rich select built on Radix DropdownMenu (keyboard nav,
 * type-ahead, focus management, and collision-aware positioning come for free).
 * Single-select via a RadioGroup; entries can render rich content. Supports an
 * opportunistic hover-to-open mode. Keep this out of always-loaded chrome so the
 * Radix dependency stays in lazy chunks (JP-149).
 */
export function RichSelect<T extends string>({
  value,
  onChange,
  items,
  trigger,
  hoverOpen = false,
  align = 'start',
  ariaLabel,
  className,
  minWidth,
}: RichSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCloseTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const openNow = useCallback(() => {
    clearCloseTimer();
    setOpen(true);
  }, []);
  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS);
  }, []);

  const current = items.find((item) => item.value === value);
  const hoverProps = hoverOpen ? { onMouseEnter: openNow, onMouseLeave: scheduleClose } : {};

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={`rich-select-trigger${className ? ` ${className}` : ''}`}
          aria-label={ariaLabel}
          style={minWidth !== undefined ? { minWidth } : undefined}
          {...hoverProps}
        >
          {trigger ?? (
            <>
              <span className="rich-select-trigger-label">{current?.label ?? ''}</span>
              <svg
                className="rich-select-chevron"
                width="12"
                height="12"
                viewBox="0 0 12 12"
                aria-hidden="true"
              >
                <path fill="currentColor" d="M2 4l4 4 4-4" />
              </svg>
            </>
          )}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="rich-select-content"
          side="bottom"
          align={align}
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={(e) => e.preventDefault()}
          {...hoverProps}
        >
          <DropdownMenu.RadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
            {items.map((item) => (
              <DropdownMenu.RadioItem
                key={item.value}
                value={item.value}
                textValue={item.keywords ?? item.label}
                className="rich-select-item"
              >
                <span className="rich-select-item-check">
                  <DropdownMenu.ItemIndicator>
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                      <path
                        d="M10 3L4.5 8.5 2 6"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        fill="none"
                      />
                    </svg>
                  </DropdownMenu.ItemIndicator>
                </span>
                <span className="rich-select-item-body">
                  {item.render ? item.render(item.value === value) : item.label}
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export default RichSelect;
