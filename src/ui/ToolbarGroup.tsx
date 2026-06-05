import type { ReactNode } from 'react';

/**
 * A toolbar cluster of related controls. Stays on a single line — a group never
 * splits across rows when its toolbar wraps; instead whole groups wrap as units,
 * separated by the parent toolbar's column-gap (no dangling dividers). Shared by
 * the region toolbars (canvas + prose ribbon) for consistent grouping + a
 * graceful wrap.
 */
export function ToolbarGroup({
  children,
  label,
  className,
}: {
  children: ReactNode;
  /** Accessible group name (also handy for future overflow labelling). */
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={`toolbar-group${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={label}
    >
      {children}
    </div>
  );
}
