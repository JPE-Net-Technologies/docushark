/**
 * MobilePropertySheet — the property panel as a full-screen sheet on mobile
 * (JP-332 Slice 3). Composes the reusable MobileSheet around the existing
 * PropertyPanel, which fills the sheet (its docked width clamps + border are
 * dropped via `property-panel--mobile`).
 *
 * `onClose` is wired by App to clear the selection — so the sheet is purely
 * selection-driven on mobile: select a shape → sheet; Done / Escape / deselect →
 * gone. This keeps the property panel from permanently covering a small screen
 * the way a docked panel would.
 */

import { MobileSheet } from './MobileSheet';
import { PropertyPanel } from '../PropertyPanel';

export function MobilePropertySheet({ onClose }: { onClose: () => void }) {
  return (
    <MobileSheet title="Properties" onClose={onClose} className="mobile-property-sheet">
      <PropertyPanel className="property-panel--mobile" />
    </MobileSheet>
  );
}
