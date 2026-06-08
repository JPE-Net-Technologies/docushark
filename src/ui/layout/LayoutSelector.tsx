/**
 * LayoutSelector — toolbar chip + dropdown for switching layouts.
 *
 * Lives in `UnifiedToolbar`, never in the titlebar. The toolbar is always our
 * own UI regardless of chrome choice, so this control is guaranteed to render.
 *
 * The dropdown footer hosts a "Customize layout…" link into Settings. The
 * custom-chrome opt-in lives in Settings → Appearance → Window (gated to the
 * desktop shell), not here.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { LAYOUT_DESCRIPTIONS, LAYOUT_LABELS } from './modes';
import { useActiveLayoutMode, useLayoutActions } from './useLayout';
import { LAYOUT_MODES, type LayoutMode } from './types';
import { LayoutThumbnail } from './LayoutThumbnail';
import './LayoutSelector.css';

export interface LayoutSelectorProps {
  /** Called when the user clicks "Customize layout…" — wires to Settings. */
  onOpenLayoutSettings?: (() => void) | undefined;
}

export function LayoutSelector({ onOpenLayoutSettings }: LayoutSelectorProps) {
  const activeMode = useActiveLayoutMode();
  const { setActiveLayout } = useLayoutActions();

  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setIsOpen(false), []);

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

  return (
    <div className="layout-selector-wrapper" ref={wrapperRef}>
      <button
        type="button"
        className={`layout-selector-chip ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={`Layout: ${LAYOUT_LABELS[activeMode]}. Click to change.`}
        title={`Layout: ${LAYOUT_LABELS[activeMode]} (Cmd+Shift+1..4)`}
      >
        <LayoutThumbnail mode={activeMode} width={22} height={14} />
        <span className="layout-selector-chip-label">{LAYOUT_LABELS[activeMode]}</span>
        <span className="layout-selector-chip-chevron" aria-hidden="true">▾</span>
      </button>

      {isOpen && (
        <div className="layout-selector-dropdown" role="menu" aria-label="Switch layout">
          <div className="layout-selector-list">
            {LAYOUT_MODES.map((mode, idx) => (
              <button
                key={mode}
                type="button"
                role="menuitemradio"
                aria-checked={mode === activeMode}
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
