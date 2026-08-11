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
 *
 * ## Positioning (JP-253)
 *
 * The panel is **portalled to the body and measured against the viewport**. It
 * used to be `position: absolute; right: 0` at a fixed 320px inside the toolbar,
 * with no clamp and no max-height, so a narrow window pushed it off-screen and a
 * short one truncated it. The compact variant that would have saved it was gated
 * on `mobileActive`, which requires a **coarse pointer** — so a narrowed desktop
 * window never qualified.
 *
 * Sizing therefore keys off `useBreakpoint().band` (viewport width), not the
 * touch signal; the coarse-pointer signal governs hit-target size only. This is
 * the same split settled in JP-486.
 *
 * `ToolbarDropdown` is deliberately not reused here: it clamps horizontally but
 * never vertically, and owns its own trigger markup and click semantics, which
 * would mean fighting it for hover-open and the menu ARIA roles below. The
 * tested pure clamp from `floatingPosition.ts` is reused instead.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PanelsTopLeft, Settings2, SlidersHorizontal, Layers, Compass, FileText } from 'lucide-react';
import { Icon } from '../icons';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';
import { LAYOUT_DESCRIPTIONS, LAYOUT_LABELS, propertiesDockedVisible, resolvePanelState } from './modes';
import { useActiveLayoutMode, useLayoutActions } from './useLayout';
import { useBreakpoint } from './useBreakpoint';
import { LAYOUT_MODES, PANEL_IDS, type LayoutMode, type PanelId } from './types';
import { LayoutThumbnail } from './LayoutThumbnail';
import { TileGroup, ToggleTile } from '../tiles/Tile';
import { resolveMenuPlacement, type MenuPlacement } from '../floatingPosition';
import './LayoutSelector.css';

/** Panel names as the user meets them elsewhere (Settings → Layout, the
 *  command palette, the docs). One name per panel, everywhere. */
const PANEL_LABELS: Record<PanelId, string> = {
  document: 'Document',
  properties: 'Properties',
  layers: 'Layers',
  navigator: 'Navigator',
};

/** One glyph per panel, so the panel tiles are icon-first like every other tile. */
const PANEL_ICONS = {
  document: FileText,
  properties: SlidersHorizontal,
  layers: Layers,
  navigator: Compass,
} as const;

/** Matches the tab strip's overflow menu — long enough to cross the gap
 *  between the chip and the panel without the menu evaporating. */
const CLOSE_DELAY_MS = 200;

/** Panel width at a regular viewport. */
const PANEL_WIDTH = 340;

/** Below this much room, opening downward would leave an unusably short panel,
 *  so it flips above the trigger instead. */
const MIN_DROP_HEIGHT = 260;

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
  const { band } = useBreakpoint();

  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<MenuPlacement | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
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

  /**
   * Place the panel against the viewport. Width shrinks on a narrow viewport;
   * the panel opens downward unless there isn't room, in which case it flips
   * above the trigger. `maxHeight` is what turns a too-tall panel into a
   * scrolling one instead of a truncated one.
   */
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const viewport = { w: window.innerWidth, h: window.innerHeight };

    // All the arithmetic lives in `resolveMenuPlacement` — pure, and unit-tested
    // in floatingPosition.test.ts, so the overflow fix is verified in CI rather
    // than only by resizing a window.
    setPosition(
      resolveMenuPlacement({
        trigger: { top: rect.top, bottom: rect.bottom, right: rect.right },
        viewport,
        preferredWidth: PANEL_WIDTH,
        narrow: band === 'narrow',
        contentHeight: panelRef.current?.scrollHeight ?? Number.POSITIVE_INFINITY,
        minDropHeight: MIN_DROP_HEIGHT,
      })
    );
  }, [band]);

  // Place before paint so the panel never renders at the wrong spot first.
  useLayoutEffect(() => {
    if (!isOpen) {
      setPosition(null);
      return;
    }
    place();
  }, [isOpen, place]);

  useEffect(() => {
    if (!isOpen) return;
    const onClickOutside = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (wrapperRef.current?.contains(target)) return;
      // The panel is portalled out of the wrapper, so it needs its own check.
      if (panelRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onReflow = () => place();

    window.addEventListener('pointerdown', onClickOutside);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onReflow);
    // Capture phase: the toolbar or a panel can scroll without the window doing so.
    window.addEventListener('scroll', onReflow, true);
    return () => {
      window.removeEventListener('pointerdown', onClickOutside);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [isOpen, close, place]);

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

  const panel = (
    <div
      ref={panelRef}
      className="layout-selector-dropdown"
      role="menu"
      aria-label="View"
      style={
        position
          ? {
              left: position.left,
              top: position.top,
              width: position.width,
              maxHeight: position.maxHeight,
            }
          : // Pre-measurement: keep it out of sight rather than flashing at 0,0.
            { visibility: 'hidden', left: 0, top: 0, width: PANEL_WIDTH }
      }
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
    >
      <TileGroup title="Layout" icon={PanelsTopLeft} min={132} row={0}>
        {LAYOUT_MODES.map((mode, idx) => (
          <button
            key={mode}
            type="button"
            role="menuitemradio"
            aria-checked={mode === activeMode}
            // The visible text lives in nested spans alongside an aria-hidden
            // thumbnail, which would otherwise leave these options nameless.
            aria-label={`${LAYOUT_LABELS[mode]} layout — ${LAYOUT_DESCRIPTIONS[mode]}`}
            className="tile tile--layout"
            onClick={() => handlePick(mode)}
          >
            <span className="layout-tile__thumb" aria-hidden="true">
              <LayoutThumbnail mode={mode} active={mode === activeMode} width={56} height={34} />
            </span>
            <span className="layout-tile__row">
              <span className="layout-tile__name">{LAYOUT_LABELS[mode]}</span>
              <span className="layout-tile__key">⌘⇧{idx + 1}</span>
            </span>
            <span className="layout-tile__desc">{LAYOUT_DESCRIPTIONS[mode]}</span>
          </button>
        ))}
      </TileGroup>

      <TileGroup title="Panels" icon={Settings2} min={132} row={0}>
        {panels.map(({ id, visible, layoutOwned }) => (
          <ToggleTile
            key={id}
            compact
            icon={PANEL_ICONS[id]}
            label={PANEL_LABELS[id]}
            checked={visible}
            disabled={layoutOwned}
            onLabel="Shown"
            offLabel="Hidden"
            {...(layoutOwned ? { note: 'on selection' } : {})}
            // The popover stays open: showing a panel is the kind of thing you
            // do two or three of in a row.
            onCheckedChange={() => togglePanelVisible(id)}
            title={
              layoutOwned
                ? 'Relaxed shows Properties only while something is selected'
                : `${visible ? 'Hide' : 'Show'} the ${PANEL_LABELS[id]} panel`
            }
          />
        ))}
      </TileGroup>

      <div className="layout-selector-footer">
        <button type="button" className="layout-selector-footer-item" onClick={handleCustomize}>
          <Icon icon={Settings2} size={15} />
          Customize layout…
        </button>
      </div>
    </div>
  );

  return (
    <div
      className="layout-selector-wrapper"
      ref={wrapperRef}
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
    >
      <button
        ref={triggerRef}
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

      {isOpen && createPortal(panel, document.body)}
    </div>
  );
}
