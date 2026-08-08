/**
 * LayoutSelector — toolbar chip + the app's "view" popover.
 *
 * Lives in `UnifiedToolbar`, never in the titlebar. The toolbar is always our
 * own UI regardless of chrome choice, so this control is guaranteed to render.
 *
 * Two sections:
 *  - **Layout** — the four presets, with thumbnails and shortcuts.
 *  - **Panels** — per-panel show/hide for the active layout. This is the only
 *    always-visible affordance for bringing a hidden panel back. The Navigator
 *    in particular ships `visible: false` in every preset, so without this row
 *    it is reachable only from Settings or the command palette — a panel you
 *    cannot find is a panel that does not exist.
 *
 * The footer hosts a "Customize layout…" link into Settings. The custom-chrome
 * opt-in lives in Settings → Appearance → Window (gated to the desktop shell),
 * not here.
 *
 * The popover opens on hover as well as click (same delayed-close pattern as
 * the page tab strip's overflow menu), so scanning the view controls costs no
 * clicks; the delay is what keeps a diagonal pointer path from dismissing it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, PanelsTopLeft } from 'lucide-react';
import { Icon } from '../icons';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';
import { LAYOUT_DESCRIPTIONS, LAYOUT_LABELS, propertiesDockedVisible, resolvePanelState } from './modes';
import { useActiveLayoutMode, useLayoutActions } from './useLayout';
import { LAYOUT_MODES, PANEL_IDS, type LayoutMode, type PanelId } from './types';
import { LayoutThumbnail } from './LayoutThumbnail';
import './LayoutSelector.css';

/** Panel names as the user meets them elsewhere (Settings → Layout, the
 *  command palette, the docs). One name per panel, everywhere. */
const PANEL_LABELS: Record<PanelId, string> = {
  document: 'Document',
  properties: 'Properties',
  layers: 'Layers',
  navigator: 'Navigator',
};

/** Matches the tab strip's overflow menu — long enough to cross the gap
 *  between the chip and the panel without the menu evaporating. */
const CLOSE_DELAY_MS = 200;

export interface LayoutSelectorProps {
  /** Called when the user clicks "Customize layout…" — wires to Settings. */
  onOpenLayoutSettings?: (() => void) | undefined;
  /** Collapse the trigger to a single icon (mobile) — the dropdown is unchanged. */
  compact?: boolean;
}

export function LayoutSelector({ onOpenLayoutSettings, compact = false }: LayoutSelectorProps) {
  const activeMode = useActiveLayoutMode();
  const { setActiveLayout, togglePanelVisible } = useLayoutActions();
  const overrides = useUIPreferencesStore((s) => s.layout.modeOverrides[activeMode]);

  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancelClose();
    setIsOpen(false);
  }, [cancelClose]);

  const open = useCallback(() => {
    cancelClose();
    setIsOpen(true);
  }, [cancelClose]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setIsOpen(false), CLOSE_DELAY_MS);
  }, [cancelClose]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  useEffect(() => {
    if (!isOpen) return;
    const onClickOutside = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && !wrapperRef.current?.contains(target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onClickOutside);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onClickOutside);
      window.removeEventListener('keydown', onKey);
    };
  }, [isOpen, close]);

  const handlePick = (mode: LayoutMode) => {
    setActiveLayout(mode);
    close();
  };

  const handleCustomize = () => {
    close();
    onOpenLayoutSettings?.();
  };

  /**
   * Effective visibility per panel. Properties reports the layout's real
   * answer, not the stored flag: in Relaxed it is a selection-only overlay and
   * never docks, so a checked box there would be a lie.
   */
  const panels = useMemo(
    () =>
      PANEL_IDS.map((id) => {
        const state = resolvePanelState(activeMode, id, overrides[id]);
        const layoutOwned = id === 'properties' && activeMode === 'relaxed';
        return {
          id,
          layoutOwned,
          visible: id === 'properties' ? propertiesDockedVisible(activeMode, state) : state.visible,
        };
      }),
    [activeMode, overrides],
  );

  return (
    <div
      className="layout-selector-wrapper"
      ref={wrapperRef}
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className={`toolbar-menu-chip layout-selector-chip ${compact ? 'compact' : ''} ${isOpen ? 'open' : ''}`}
        onClick={() => (isOpen ? close() : open())}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={`View: ${LAYOUT_LABELS[activeMode]} layout. Click to change layout and panels.`}
        title={`Layout: ${LAYOUT_LABELS[activeMode]} (Cmd+Shift+1..4)`}
      >
        {compact ? (
          <Icon icon={PanelsTopLeft} />
        ) : (
          <>
            <LayoutThumbnail mode={activeMode} width={22} height={14} />
            <span className="layout-selector-chip-label">{LAYOUT_LABELS[activeMode]}</span>
            <span className="layout-selector-chip-chevron" aria-hidden="true">▾</span>
          </>
        )}
      </button>

      {isOpen && (
        <div className="layout-selector-dropdown" role="menu" aria-label="View">
          <div className="layout-selector-section-label">Layout</div>
          <div className="layout-selector-list">
            {LAYOUT_MODES.map((mode, idx) => (
              <button
                key={mode}
                type="button"
                role="menuitemradio"
                aria-checked={mode === activeMode}
                // The visible text lives in nested divs alongside an
                // aria-hidden thumbnail, which left these options nameless.
                aria-label={`${LAYOUT_LABELS[mode]} layout — ${LAYOUT_DESCRIPTIONS[mode]}`}
                className={`layout-selector-option ${mode === activeMode ? 'active' : ''}`}
                onClick={() => handlePick(mode)}
              >
                <LayoutThumbnail mode={mode} active={mode === activeMode} />
                <div className="layout-selector-option-text">
                  <div className="layout-selector-option-title">
                    {LAYOUT_LABELS[mode]}
                    <span className="layout-selector-option-shortcut">⌘⇧{idx + 1}</span>
                  </div>
                  <div className="layout-selector-option-desc">{LAYOUT_DESCRIPTIONS[mode]}</div>
                </div>
              </button>
            ))}
          </div>

          <div className="layout-selector-panels">
            <div className="layout-selector-section-label">Panels</div>
            {panels.map(({ id, visible, layoutOwned }) => (
              <button
                key={id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={visible}
                disabled={layoutOwned}
                className="layout-selector-panel-item"
                // A checkbox is named for the thing, not the action — the
                // action is already carried by the role plus aria-checked.
                aria-label={PANEL_LABELS[id]}
                // The popover stays open: showing a panel is the kind of thing
                // you do two or three of in a row.
                onClick={() => togglePanelVisible(id)}
                title={
                  layoutOwned
                    ? 'Relaxed shows Properties only while something is selected'
                    : `${visible ? 'Hide' : 'Show'} the ${PANEL_LABELS[id]} panel`
                }
              >
                <span className="layout-selector-panel-check" aria-hidden="true">
                  {visible && <Icon icon={Check} size={13} />}
                </span>
                <span className="layout-selector-panel-label">{PANEL_LABELS[id]}</span>
                {layoutOwned && <span className="layout-selector-panel-note">on selection</span>}
              </button>
            ))}
          </div>

          <div className="layout-selector-footer">
            <button
              type="button"
              className="layout-selector-footer-item"
              onClick={handleCustomize}
            >
              Customize layout…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
