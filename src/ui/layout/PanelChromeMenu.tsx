/**
 * PanelChromeMenu — small popover invoked by right-clicking a panel header, or
 * by clicking the "more" affordance inside FlyoutPanel's header. Offers the
 * three Phase A customization actions (move left, move right, hide) plus
 * pin/unpin when applicable.
 *
 * Edits are scoped to the active layout via `useLayoutActions`, matching the
 * "deltas stored per-layout" rule.
 */

import { useEffect, useRef } from 'react';
import { useActivePanelState, useLayoutActions } from './useLayout';
import { isFlyoutLayout } from './modes';
import { useActiveLayoutMode } from './useLayout';
import type { PanelId } from './types';
import './PanelChromeMenu.css';

export interface PanelChromeMenuProps {
  panelId: PanelId;
  x: number;
  y: number;
  onClose: () => void;
}

export function PanelChromeMenu({ panelId, x, y, onClose }: PanelChromeMenuProps) {
  const state = useActivePanelState(panelId);
  const mode = useActiveLayoutMode();
  const { setPanelDock, setPanelVisible, togglePin } = useLayoutActions();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && !ref.current?.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Defer one tick so the same right-click that opened us doesn't close us.
    const id = window.setTimeout(() => {
      window.addEventListener('pointerdown', onClick);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('pointerdown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const flyoutEligible = isFlyoutLayout(mode);

  return (
    <div
      ref={ref}
      role="menu"
      className="panel-chrome-menu"
      style={{ top: y, left: x }}
    >
      <button
        type="button"
        role="menuitem"
        className="panel-chrome-menu-item"
        disabled={state.dock === 'left'}
        onClick={() => {
          setPanelDock(panelId, 'left');
          onClose();
        }}
      >
        Move to left
      </button>
      <button
        type="button"
        role="menuitem"
        className="panel-chrome-menu-item"
        disabled={state.dock === 'right'}
        onClick={() => {
          setPanelDock(panelId, 'right');
          onClose();
        }}
      >
        Move to right
      </button>
      <button
        type="button"
        role="menuitem"
        className="panel-chrome-menu-item"
        disabled={!state.visible}
        onClick={() => {
          setPanelVisible(panelId, false);
          onClose();
        }}
      >
        Hide
      </button>
      {!state.visible && (
        <button
          type="button"
          role="menuitem"
          className="panel-chrome-menu-item"
          onClick={() => {
            setPanelVisible(panelId, true);
            onClose();
          }}
        >
          Show
        </button>
      )}
      {flyoutEligible && (
        <>
          <div className="panel-chrome-menu-divider" />
          <button
            type="button"
            role="menuitem"
            className="panel-chrome-menu-item"
            onClick={() => {
              togglePin(panelId);
              onClose();
            }}
          >
            {state.pinned ? 'Unpin (auto-collapse)' : 'Pin open'}
          </button>
        </>
      )}
    </div>
  );
}
