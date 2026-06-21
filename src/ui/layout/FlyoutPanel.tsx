/**
 * FlyoutPanel — collapsible panel wrapper used by Designer + Technician.
 *
 * Renders as a thin rail along the canvas edge; expands into a full panel on:
 *  - rail click
 *  - focus entering the panel body
 *  - shape selection (Properties only — opt-in via `expandOnSelection`)
 *
 * Collapses 500ms after focus leaves the panel, or immediately on Escape /
 * outside-click. A pin button promotes the panel to docked for the active
 * layout, after which FlyoutPanel renders nothing and the parent is expected
 * to render the wrapped panel itself.
 *
 * A11y: slide animation honors prefers-reduced-motion; expanded body traps
 * focus until Escape / outside-click. ARIA roles on rail and panel.
 */

import { ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useSessionStore } from '../../store/sessionStore';
import { useActivePanelState, useLayoutActions } from './useLayout';
import type { PanelId } from './types';
import './FlyoutPanel.css';

const AUTO_COLLAPSE_DELAY_MS = 500;

export interface FlyoutPanelProps {
  /** Stable panel id (also used for store actions and aria-labelling). */
  panelId: PanelId;
  /** Human-readable label for the rail tooltip + ARIA name. */
  label: string;
  /** Icon rendered on the rail. */
  icon: ReactNode;
  /** When true, the panel auto-expands whenever shape selection becomes non-empty. */
  expandOnSelection?: boolean;
  /** Which side of the canvas this panel docks to. Affects border + chevron. */
  side?: 'left' | 'right';
  /**
   * When false, the rail is hidden entirely — the panel renders nothing in
   * the collapsed state. Used in Relaxed for selection-only Properties.
   */
  showRail?: boolean;
  /** Panel body — only mounted/visible when expanded. */
  children: ReactNode;
}

export function FlyoutPanel({
  panelId,
  label,
  icon,
  expandOnSelection = false,
  side = 'right',
  showRail = true,
  children,
}: FlyoutPanelProps) {
  const { togglePin } = useLayoutActions();
  // Body width is sourced from the same store slot PropertyPanel writes to,
  // so resizing in any layout persists and the fly-out body matches the
  // pinned/docked PropertyPanel width at all times.
  const panelState = useActivePanelState(panelId);
  const bodyWidth = panelState.width ?? 280;
  const [isExpanded, setIsExpanded] = useState(false);
  const expandedRef = useRef(isExpanded);
  expandedRef.current = isExpanded;

  const collapseTimerRef = useRef<number | null>(null);
  const railRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const labelId = useId();

  const cancelCollapseTimer = useCallback(() => {
    if (collapseTimerRef.current !== null) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  }, []);

  const scheduleCollapse = useCallback(() => {
    cancelCollapseTimer();
    // A panel-owned popover (color/icon/pattern/border picker) mounts its
    // `[data-flyout-keep-open]` portal asynchronously, so a focusout that races
    // ahead of the mount could schedule a collapse while the popover is open.
    // If one is open when the timer fires, the panel is in use — re-arm instead
    // of collapsing, so we still close once the popover goes away.
    const arm = () => {
      collapseTimerRef.current = window.setTimeout(() => {
        collapseTimerRef.current = null;
        if (document.querySelector('[data-flyout-keep-open]')) {
          arm();
          return;
        }
        setIsExpanded(false);
      }, AUTO_COLLAPSE_DELAY_MS);
    };
    arm();
  }, [cancelCollapseTimer]);

  const expand = useCallback(() => {
    cancelCollapseTimer();
    setIsExpanded(true);
  }, [cancelCollapseTimer]);

  const collapseNow = useCallback(() => {
    cancelCollapseTimer();
    setIsExpanded(false);
  }, [cancelCollapseTimer]);

  // Auto-expand on selection — only Properties opts in. Subscribe to the
  // selectedIds reference (not just .size) so every selection change re-fires
  // the effect, even click-to-click transitions that keep the count at 1
  // (e.g. drilling into a group). This is necessary because a transient
  // empty selection from a rapid click sequence would otherwise leave a
  // pending collapse timer behind that the next click can't cancel.
  const selectedIds = useSessionStore((s) => s.selectedIds);
  const hasSelection = selectedIds.size > 0;
  useEffect(() => {
    if (!expandOnSelection) return;
    if (hasSelection) {
      // Always cancel pending collapse when something is selected — handles
      // the 0 → 1 race where a previous schedule was queued during a brief
      // empty state.
      cancelCollapseTimer();
      if (!expandedRef.current) expand();
    } else if (expandedRef.current) {
      scheduleCollapse();
    }
  }, [selectedIds, hasSelection, expandOnSelection, expand, scheduleCollapse, cancelCollapseTimer]);

  // Focus-trap + outside-click + Escape handling while expanded.
  useEffect(() => {
    if (!isExpanded) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        collapseNow();
        railRef.current?.focus();
      } else if (e.key === 'Tab' && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'a, button, input, textarea, select, [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      // Inside the panel or its rail — never collapse.
      if (panelRef.current?.contains(target) || railRef.current?.contains(target)) return;
      // A panel-owned popover (e.g. the color palette) renders outside our DOM
      // subtree via a portal but is logically part of the panel. It opts in by
      // tagging its root with `data-flyout-keep-open`, so interacting with it
      // must not collapse us.
      if (target instanceof Element && target.closest('[data-flyout-keep-open]')) return;
      // Selection-driven panels (Properties) let the selection effect own
      // visibility: clicking a different shape keeps a non-empty selection, so
      // collapsing here would race the auto-expand effect (flicker, or a stale
      // expandedRef leaving us stuck closed). Clicking truly away clears the
      // selection, and the selection effect collapses us then.
      if (expandOnSelection && useSessionStore.getState().selectedIds.size > 0) return;
      collapseNow();
    };

    window.addEventListener('keydown', handleKey);
    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isExpanded, collapseNow, expandOnSelection]);

  // Auto-collapse 500ms after focus leaves the panel body.
  const handleFocusIn = useCallback(() => {
    cancelCollapseTimer();
  }, [cancelCollapseTimer]);

  const handleFocusOut = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      // Only schedule collapse if focus left the panel entirely (relatedTarget
      // is null or outside our subtree).
      const next = e.relatedTarget as Node | null;
      if (next && panelRef.current?.contains(next)) return;
      // Focus moving into a panel-owned portaled popover (color palette, etc.)
      // is still "inside" the panel — don't collapse.
      if (next instanceof Element && next.closest('[data-flyout-keep-open]')) return;
      scheduleCollapse();
    },
    [scheduleCollapse]
  );

  // Cleanup pending timer on unmount.
  useEffect(() => cancelCollapseTimer, [cancelCollapseTimer]);

  const handlePin = useCallback(() => {
    togglePin(panelId);
    // After pinning, the parent will swap us out for a docked render of the
    // same panel; collapsing here keeps the rail from briefly flashing.
    collapseNow();
  }, [togglePin, panelId, collapseNow]);

  const sideClass = side === 'left' ? 'flyout-panel-side-left' : 'flyout-panel-side-right';

  const railHiddenClass = showRail ? '' : 'flyout-panel-no-rail';

  return (
    <div className={`flyout-panel ${sideClass} ${railHiddenClass} ${isExpanded ? 'flyout-panel-expanded' : 'flyout-panel-collapsed'}`}>
      {showRail && (
        <button
          ref={railRef}
          type="button"
          className="flyout-panel-rail"
          aria-label={`Open ${label}`}
          title={label}
          aria-expanded={isExpanded}
          aria-controls={labelId}
          onClick={expand}
          // Hovering the rail expands too — matches the spec's "hover, focus,
          // or shape-selection" trigger list.
          onMouseEnter={expand}
          tabIndex={isExpanded ? -1 : 0}
        >
          <span className="flyout-panel-rail-icon" aria-hidden="true">{icon}</span>
          <span className="flyout-panel-rail-label" aria-hidden="true">{label}</span>
          <span className="flyout-panel-rail-chevron" aria-hidden="true">›</span>
        </button>
      )}

      {isExpanded && (
        <div
          ref={panelRef}
          id={labelId}
          role="region"
          aria-label={label}
          className="flyout-panel-body"
          style={{ width: bodyWidth }}
          onFocus={handleFocusIn}
          onBlur={handleFocusOut}
          onMouseEnter={handleFocusIn}
          onMouseLeave={(e) => {
            // Don't start the auto-collapse timer while the user is dragging —
            // a resize handle pull can briefly leave the body's bounds while
            // a mouse button is still held. Without this check, the panel
            // collapses mid-drag and the user has to pin it before resizing.
            if (e.buttons === 0) scheduleCollapse();
          }}
        >
          <div className="flyout-panel-header">
            <span className="flyout-panel-header-title">{label}</span>
            <button
              type="button"
              className="flyout-panel-pin"
              onClick={handlePin}
              aria-label={`Pin ${label} open`}
              title={`Pin ${label} open`}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z" />
              </svg>
            </button>
          </div>
          <div className="flyout-panel-content">{children}</div>
        </div>
      )}
    </div>
  );
}
