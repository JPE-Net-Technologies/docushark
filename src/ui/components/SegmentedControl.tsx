/**
 * SegmentedControl — a horizontal single-select control styled as a segmented
 * button group, built on Radix `RadioGroup` (roving-tabindex keyboard nav,
 * arrow keys, WAI-ARIA radiogroup semantics for free).
 *
 * Thin local wrapper so the rest of the app consumes *our* component, not Radix
 * directly — the dependency is swappable and the styling stays brand-tokened.
 */

import * as RadioGroup from '@radix-ui/react-radio-group';
import type { ReactNode } from 'react';
import './SegmentedControl.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Optional leading icon (e.g. a lucide glyph). */
  icon?: ReactNode;
  /** Native title / tooltip. */
  title?: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  /** Accessible label for the group (required — there's no visible legend). */
  ariaLabel: string;
  /** Optional form name. */
  name?: string;
  disabled?: boolean;
}

export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
  name,
  disabled,
}: SegmentedControlProps<T>) {
  return (
    <RadioGroup.Root
      className="segmented-control"
      value={value}
      onValueChange={(v) => onValueChange(v as T)}
      aria-label={ariaLabel}
      orientation="horizontal"
      loop
      {...(name !== undefined ? { name } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
    >
      {options.map((opt) => (
        <RadioGroup.Item
          key={opt.value}
          className="segmented-control__item"
          value={opt.value}
          {...(opt.title !== undefined ? { title: opt.title } : {})}
        >
          {opt.icon != null && (
            <span className="segmented-control__icon" aria-hidden="true">
              {opt.icon}
            </span>
          )}
          <span className="segmented-control__label">{opt.label}</span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
