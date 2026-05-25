/**
 * LayoutSelector — toolbar chip + dropdown for switching layouts.
 *
 * Lives in `UnifiedToolbar`, never in the titlebar. The toolbar is always our
 * own UI regardless of chrome choice, so this control is guaranteed to render.
 *
 * The dropdown footer hosts the custom-chrome opt-in and a "Customize layout"
 * link into Settings.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';
import { usePersistenceStore } from '../../store/persistenceStore';
import { useNotificationStore } from '../../store/notificationStore';
import { applyCustomChrome, isTauri, persistCustomChrome } from '../../tauri/commands';
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
  const customChrome = useUIPreferencesStore((s) => s.layout.customChrome);
  const setCustomChrome = useUIPreferencesStore((s) => s.setCustomChrome);

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

  const handleChromeToggle = () => {
    const next = !customChrome;
    const inTauri = isTauri();
    const verb = inTauri
      ? import.meta.env.DEV
        ? 'The flag will be saved (manual `tauri:dev` restart required)'
        : 'The app will restart'
      : 'The window will reload';
    const confirmed = window.confirm(
      next
        ? `Use custom window chrome? ${verb} to apply.`
        : `Revert to system window decorations? ${verb} to apply.`
    );
    if (!confirmed) return;
    setCustomChrome(next);
    // Flush any pending auto-save so the beforeunload handler in useAutoSave
    // doesn't fire its "unsaved changes" prompt during the reload path. (In
    // Tauri we skip the JS reload entirely, but doing this unconditionally
    // also handles the web PWA path.)
    try {
      usePersistenceStore.getState().saveDocument();
    } catch {
      // Best-effort flush; the user already confirmed they want to reload.
    }
    if (isTauri()) {
      // Desktop: persist the flag, then either restart (prod) or just
      // warn the developer (dev). The restart path is required on Linux
      // WMs that ignore runtime setDecorations.
      //
      // Dev-mode caveat: `app.restart()` under `tauri dev` kills the
      // cargo-spawned binary without re-spawning it (and the dev-server
      // bridge wouldn't reattach cleanly anyway), so we persist the
      // flag without restarting and tell the developer to bounce
      // `bun run tauri:dev` themselves. Production bundles are fine.
      if (import.meta.env.DEV) {
        void persistCustomChrome(next);
        useNotificationStore.getState().warning(
          'Custom chrome flag saved. In dev mode you must stop and restart `bun run tauri:dev` manually for it to take effect.',
          { duration: 10000 }
        );
      } else {
        void applyCustomChrome(next);
      }
    } else {
      // Web/PWA: no native chrome to swap, but a reload re-mounts so the
      // optional in-app TitleBar appears/disappears consistently.
      window.location.reload();
    }
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
            <label className="layout-selector-footer-item layout-selector-toggle">
              <input
                type="checkbox"
                checked={customChrome}
                onChange={handleChromeToggle}
              />
              <span>Use custom window chrome</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
