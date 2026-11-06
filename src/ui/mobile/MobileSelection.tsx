/**
 * What a phone does with a selection (DSK-223). A tap only selects, so a stray tap
 * costs nothing and a selected shape can be dragged. A small bar then offers its
 * properties and Delete.
 *
 * Properties rises over the lower part of the screen, with no scrim: the shape
 * stays in view above it, changes show as you make them, and tapping the canvas
 * selects another shape or deselects. Done puts it away and keeps the selection.
 */
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { getAllCommands } from '../../engine/CommandRegistry';
import { cameraToRevealAbove, glideCamera } from '../../engine/canvasZoom';
import { calculateCombinedBounds } from '../../shapes/utils/bounds';
import { isGroup, type Shape } from '../../shapes/Shape';
import { shapeRegistry } from '../../shapes/ShapeRegistry';
import { useActiveDocReadOnly } from '../../store/documentRegistry';
import { getSelectedShapes, useSessionStore } from '../../store/sessionStore';
import { isCanvasHidden } from '../layout/modes';
import { useActiveLayoutMode } from '../layout/useLayout';
import { useBreakpoint } from '../layout/useBreakpoint';
import { useMobileAdaptation } from '../layout/useMobileAdaptation';
import { Icon } from '../icons';
import { MobilePropertySheet, PROPERTY_SHEET_TOP } from './MobilePropertySheet';
import './MobileSelection.css';

/** What the bar calls the selection. */
function describe(shapes: Shape[]): string {
  const [only] = shapes;
  if (shapes.length !== 1 || !only) return `${shapes.length} shapes`;
  if (isGroup(only)) return `Group (${only.childIds.length})`;
  return shapeRegistry.getMetadata(only.type)?.name ?? only.type.charAt(0).toUpperCase() + only.type.slice(1);
}

/** The sheet would hide a shape in the lower part of the screen: bring it up. */
function revealSelectionAboveSheet(): void {
  const canvas = document.querySelector('.canvas-area-wrapper')?.getBoundingClientRect();
  const bounds = calculateCombinedBounds(getSelectedShapes());
  if (!canvas || !bounds) return;
  const coveredFrom = window.innerHeight * PROPERTY_SHEET_TOP - canvas.top;
  const target = cameraToRevealAbove(bounds, useSessionStore.getState().camera, canvas.height, coveredFrom);
  if (target) glideCamera(target);
}

export function MobileSelection() {
  const { mobileActive } = useMobileAdaptation();
  const mode = useActiveLayoutMode();
  const focus = useSessionStore((state) => state.relaxedFocus);
  const { band } = useBreakpoint();
  const selectionCount = useSessionStore((state) => state.selectedIds.size);
  // Subscribed so the name follows the selection.
  useSessionStore((state) => state.selectedIds);
  const readOnly = useActiveDocReadOnly();
  const [sheetOpen, setSheetOpen] = useState(false);

  // The sheet belongs to a selection: the next one starts with the bar.
  useEffect(() => {
    if (selectionCount === 0) setSheetOpen(false);
  }, [selectionCount]);

  // A selection left behind in Write focus has nothing to act on.
  if (!mobileActive || selectionCount === 0 || isCanvasHidden(mode, focus, band)) return null;
  const name = describe(getSelectedShapes());
  if (sheetOpen) return <MobilePropertySheet title={name} onClose={() => setSheetOpen(false)} />;

  const deleteCommand = getAllCommands().find((command) => command.id === 'edit.delete');

  return (
    <div className="mobile-selection-bar" role="toolbar" aria-label="Selection">
      <span className="mobile-selection-name">{name}</span>
      <button
        type="button"
        className="mobile-selection-properties"
        onClick={() => {
          setSheetOpen(true);
          revealSelectionAboveSheet();
        }}
      >
        Properties
      </button>
      {!readOnly && (
        <button
          type="button"
          className="mobile-selection-delete"
          aria-label="Delete"
          onClick={() => deleteCommand?.execute()}
        >
          <Icon icon={Trash2} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
