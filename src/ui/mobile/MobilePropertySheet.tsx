/**
 * MobilePropertySheet — the property panel as a sheet on mobile (JP-332 Slice 3).
 * Composes the reusable MobileSheet around the existing PropertyPanel, which fills
 * the sheet (its docked width clamps + border are dropped via
 * `property-panel--mobile`).
 *
 * It covers the lower part of the screen with no scrim (DSK-223), so the shape stays
 * in view and changes show as you make them. While typing it takes the whole height
 * above the keyboard: the lower part of the screen is the keyboard's by then.
 */

import { useKeyboardInset } from './useKeyboardInset';
import { MobileSheet } from './MobileSheet';
import { PropertyPanel } from '../PropertyPanel';

/** Where the sheet's top edge sits, as a share of the screen's height. */
export const PROPERTY_SHEET_TOP = 0.45;

export function MobilePropertySheet({ title, onClose }: { title: string; onClose: () => void }) {
  const keyboardInset = useKeyboardInset();
  return (
    <MobileSheet
      title={title}
      onClose={onClose}
      className="mobile-property-sheet"
      modal={false}
      style={
        keyboardInset > 0
          ? { top: 0, bottom: keyboardInset }
          : { top: `${PROPERTY_SHEET_TOP * 100}dvh` }
      }
    >
      <PropertyPanel className="property-panel--mobile" />
    </MobileSheet>
  );
}
