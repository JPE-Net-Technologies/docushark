/**
 * Everyday styling at the shape (DSK-225): selecting one shows a small bar above it
 * with recent style profiles, its colours, and More for the Properties panel. The
 * canvas twin of the prose selection bubble.
 *
 * It keeps out of the way while you work on the canvas: during a drag or a resize,
 * in a text edit, with a drawing tool in hand. Phones have their own bar (DSK-223),
 * and General settings turns this one off.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { calculateCombinedBounds } from '../../shapes/utils/bounds';
import type { Shape } from '../../shapes/Shape';
import { useActiveDocReadOnly } from '../../store/documentRegistry';
import { useDocumentStore } from '../../store/documentStore';
import { pushEditHistory } from '../../store/historyStore';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useStyleProfileStore, type StyleProfile } from '../../store/styleProfileStore';
import { CompactColorInput } from '../CompactColorInput';
import { Popover } from '../components/Popover';
import { focusCanvas } from '../layout/focusRegions';
import { isCanvasHidden, isFlyoutLayout } from '../layout/modes';
import { useBreakpoint } from '../layout/useBreakpoint';
import { useActiveLayoutMode, useActivePanelState } from '../layout/useLayout';
import { useMobileAdaptation } from '../layout/useMobileAdaptation';
import { getPreviewStyle } from '../StyleProfilePanel';
import { useOfferedProfiles, useSelectionStyle } from '../styleProfile/ProfileDepartures';
import { useProfileActions } from '../styleProfile/useProfileActions';
import { tip } from '../TooltipLayer';
import {
  colorSlots,
  colorUpdate,
  placeSelectionBar,
  quickProfiles,
  slotColor,
  slotIsMixed,
  SLOT_NAMES,
} from './selectionBarModel';
import './CanvasSelectionBar.css';

/** True from pressing the canvas until letting go: a drag, a resize or a marquee. */
function useCanvasGesture(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const down = (event: PointerEvent) => {
      if (event.target instanceof HTMLCanvasElement) setActive(true);
    };
    const end = () => setActive(false);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    window.addEventListener('contextmenu', end, true);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      window.removeEventListener('contextmenu', end, true);
      window.removeEventListener('blur', end);
    };
  }, []);
  return active;
}

interface CanvasSize {
  canvasWidth: number;
  canvasHeight: number;
}

export function CanvasSelectionBar({ canvasWidth, canvasHeight }: CanvasSize) {
  const enabled = useSettingsStore((state) => state.showSelectionBar);
  const selectedIds = useSessionStore((state) => state.selectedIds);
  const shapes = useDocumentStore((state) => state.shapes);
  const tool = useSessionStore((state) => state.activeTool);
  const editingText = useSessionStore((state) => state.editingTextId);
  const focus = useSessionStore((state) => state.relaxedFocus);
  const mode = useActiveLayoutMode();
  const { band } = useBreakpoint();
  const { mobileActive } = useMobileAdaptation();
  const readOnly = useActiveDocReadOnly();
  const gesture = useCanvasGesture();

  const selected = useMemo(
    () => Array.from(selectedIds).map((id) => shapes[id]).filter((shape): shape is Shape => shape !== undefined),
    [selectedIds, shapes],
  );

  const shown =
    enabled &&
    selected.length > 0 &&
    tool === 'select' &&
    editingText === null &&
    !gesture &&
    !readOnly &&
    !mobileActive &&
    !isCanvasHidden(mode, focus, band);
  if (!shown) return null;

  return <Bar selected={selected} canvasWidth={canvasWidth} canvasHeight={canvasHeight} />;
}

function Bar({ selected, canvasWidth, canvasHeight }: CanvasSize & { selected: Shape[] }) {
  const camera = useSessionStore((state) => state.camera);
  const selectedIds = useSessionStore((state) => state.selectedIds);
  const requested = useSessionStore((state) => state.propertiesRequested);
  const setRequested = useSessionStore((state) => state.setPropertiesRequested);
  const updateShape = useDocumentStore((state) => state.updateShape);
  const mode = useActiveLayoutMode();
  const panel = useActivePanelState('properties');
  const docked = panel.visible && (!isFlyoutLayout(mode) || panel.pinned);

  const actions = useProfileActions(selected);
  const offered = useOfferedProfiles();
  const { profile: current } = useSelectionStyle(selected);

  // Worked out once per selection: applying one mustn't move the others under the
  // pointer, as they'd be different profiles for the next press.
  const selectionKey = Array.from(selectedIds).join(' ');
  const quick = useMemo(
    () => quickProfiles(offered, useStyleProfileStore.getState().recentProfileIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectionKey, offered.length],
  );

  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);

  const barRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (bar && (bar.offsetWidth !== size.width || bar.offsetHeight !== size.height)) {
      setSize({ width: bar.offsetWidth, height: bar.offsetHeight });
    }
  });

  // Whatever the hover was showing goes when the bar does.
  const { endPreview } = actions;
  useEffect(() => endPreview, [endPreview]);

  const slots = colorSlots(selected);
  const setColor = (slot: (typeof slots)[number], color: string) => {
    pushEditHistory('Change colour');
    for (const shape of selected) updateShape(shape.id, colorUpdate(shape, slot, color));
  };

  const apply = (profile: StyleProfile, pointer: boolean) => {
    actions.applyProfile(profile);
    setMenuAnchor(null);
    // The canvas hears its shortcuts only while it has focus (DSK-214).
    if (pointer) focusCanvas();
  };

  const previewHandlers = (profile: StyleProfile) => ({
    onMouseEnter: () => actions.previewProfile(profile),
    onMouseLeave: () => actions.endPreview(),
    onFocus: () => actions.previewProfile(profile),
    onBlur: () => actions.endPreview(),
  });

  const bounds = calculateCombinedBounds(selected);
  const panelWidth = requested && !docked ? panel.width ?? 280 : 0;
  const place = bounds
    ? placeSelectionBar(bounds, camera, { width: canvasWidth, height: canvasHeight }, size, {
        left: panel.dock === 'left' ? panelWidth : 0,
        right: panel.dock === 'left' ? 0 : panelWidth,
      })
    : null;
  if (!place) return null;

  return (
    <div
      ref={barRef}
      className="selection-bar"
      role="toolbar"
      aria-label="Selection"
      style={{ left: place.left, top: place.top }}
    >
      {quick.map((profile) => (
        <button
          key={profile.id}
          type="button"
          className="selection-bar-profile"
          aria-label={`Apply ${profile.name}`}
          aria-pressed={current?.id === profile.id}
          onClick={(event) => apply(profile, event.detail > 0)}
          {...previewHandlers(profile)}
          {...tip(profile.name, undefined, 'Apply this style profile.')}
        >
          <span className="selection-bar-swatch" style={getPreviewStyle(profile.properties)} aria-hidden="true" />
        </button>
      ))}
      <button
        ref={menuButton}
        type="button"
        className="selection-bar-profile"
        aria-label="All style profiles"
        aria-haspopup="dialog"
        aria-expanded={menuAnchor !== null}
        onClick={(event) => setMenuAnchor(menuAnchor ? null : event.currentTarget.getBoundingClientRect())}
        {...tip('All style profiles')}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {menuAnchor && (
        <Popover
          anchor={menuAnchor}
          label="All style profiles"
          triggerRef={menuButton}
          className="selection-bar-menu"
          onClose={() => {
            setMenuAnchor(null);
            actions.endPreview();
          }}
        >
          {offered.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className="selection-bar-menu-item"
              aria-pressed={current?.id === profile.id}
              onClick={(event) => apply(profile, event.detail > 0)}
              {...previewHandlers(profile)}
            >
              <span className="selection-bar-swatch" style={getPreviewStyle(profile.properties)} aria-hidden="true" />
              {profile.name}
            </button>
          ))}
        </Popover>
      )}

      {slots.length > 0 && <span className="selection-bar-divider" aria-hidden="true" />}
      {slots.map((slot) => (
        <span key={slot} className={`selection-bar-slot selection-bar-slot--${slot}`}>
          <CompactColorInput
            label={`${SLOT_NAMES[slot]}${slotIsMixed(selected, slot) ? ' (Mixed)' : ''}`}
            value={slotColor(selected[0]!, slot)}
            onChange={(color) => setColor(slot, color)}
            showNoFill={slot === 'fill'}
            showAuto
            swatchOnly
          />
        </span>
      ))}

      {!docked && (
        <>
          <span className="selection-bar-divider" aria-hidden="true" />
          <button
            type="button"
            className="selection-bar-more"
            aria-pressed={requested}
            onClick={() => setRequested(!requested)}
            {...tip('More', undefined, 'Every setting for this selection, in the Properties panel.')}
          >
            More
          </button>
        </>
      )}
    </div>
  );
}
