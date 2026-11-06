/**
 * A selection's style profile, as one row of the properties panel (DSK-216). A
 * profile is a property of the shape, like a paragraph style in a word processor,
 * and the gallery used to hold more than half the panel whatever was selected.
 *
 * The row names what the selection looks like. Shapes don't record a profile, so
 * that's the one they all match, or Custom, or Mixed when they differ.
 *
 * Pressing it opens the gallery in the panel, under the row, covering the
 * properties until a profile is chosen. It stays in the panel rather than floating
 * in a popover: the canvas stays in view for the hover preview, the width comes
 * from the panel, and the gallery's right-click menu and Studio keep working. A
 * portalled popover's backdrop filter would trap them, its "outside" clicks would
 * close them, and the fly-out would collapse around them.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { extractStyleFromShape, findSelectionProfile, useStyleProfileStore } from '../../store/styleProfileStore';
import type { Shape } from '../../shapes/Shape';
import { StyleProfilePanel, getPreviewStyle } from '../StyleProfilePanel';
import { tip } from '../TooltipLayer';
import './StyleRow.css';

export function StyleRow({ selectedShapes }: { selectedShapes: Shape[] }) {
  const profiles = useStyleProfileStore((state) => state.profiles);
  const hideDefaults = useSettingsStore((state) => state.hideDefaultStyleProfiles);
  const selectedIds = useSessionStore((state) => state.selectedIds);

  const [open, setOpen] = useState(false);
  const [top, setTop] = useState(0);
  const rowRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  const profile = useMemo(() => {
    const candidates = useStyleProfileStore
      .getState()
      .getSortedProfiles()
      .filter((candidate) => !hideDefaults || !candidate.id.startsWith('default-'));
    return findSelectionProfile(selectedShapes, candidates);
    // `profiles` is what getSortedProfiles reads.
  }, [selectedShapes, profiles, hideDefaults]);

  const name = profile?.name ?? (selectedShapes.length > 1 ? 'Mixed' : 'Custom');
  const swatch = useMemo(() => {
    if (profile) return getPreviewStyle(profile.properties);
    const [only] = selectedShapes;
    return selectedShapes.length === 1 && only ? getPreviewStyle(extractStyleFromShape(only)) : undefined;
  }, [profile, selectedShapes]);

  const closeAndFocus = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // The gallery covers everything below the row, however tall what's above it is.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (open && row) setTop(row.offsetTop + row.offsetHeight);
  }, [open]);

  // It belongs to the selection it opened for.
  useEffect(() => setOpen(false), [selectedIds]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // One press dismisses the top layer, so it stops here: the fly-out around
      // the panel would collapse too. The right-click menu and the Studio listen
      // on the document as well, and close themselves.
      event.stopPropagation();
      if (layerRef.current?.querySelector('.style-profile-context-menu, [role="dialog"]')) return;
      closeAndFocus();
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (rowRef.current?.contains(target)) return;
      // The gallery is a dialog, and so is one it raises, such as confirming a delete.
      if (target.closest?.('[role="dialog"], [role="alertdialog"]')) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, closeAndFocus]);

  return (
    <>
      <div ref={rowRef} className="style-row" data-open={open || undefined}>
        <span className="style-row-label">Style</span>
        <button
          ref={triggerRef}
          type="button"
          className="style-row-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Style profile: ${name}`}
          onClick={() => setOpen((value) => !value)}
          {...tip('Style profile', undefined, 'A saved look you can apply to any shape. Choose one for this selection, or save its look as a new one.')}
        >
          <span className="style-row-swatch" style={swatch} aria-hidden="true" />
          <span className="style-row-name">{name}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div ref={layerRef} className="style-row-layer" style={{ top }} role="dialog" aria-label="Style profiles">
          <StyleProfilePanel picker onApplied={closeAndFocus} currentProfileId={profile?.id} />
        </div>
      )}
    </>
  );
}
