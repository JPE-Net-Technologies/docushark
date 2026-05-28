/**
 * Settings → Layout — power-user surface for customizing each layout's panel
 * arrangement. Phase A renders a simple per-panel dock dropdown per layout,
 * plus reset and the custom-chrome toggle. A drag-between-columns visual
 * editor is on the backlog.
 */

import { useUIPreferencesStore } from '../../store/uiPreferencesStore';
import {
  LAYOUT_DESCRIPTIONS,
  LAYOUT_LABELS,
  LAYOUT_PRESETS,
  resolvePanelState,
} from '../layout/modes';
import { LAYOUT_MODES, PANEL_IDS, type DockSide, type LayoutMode, type PanelId, type PanelState } from '../layout/types';
import { LayoutThumbnail } from '../layout/LayoutThumbnail';
import './LayoutSettings.css';

const PANEL_LABELS: Record<PanelId, string> = {
  document: 'Document',
  properties: 'Properties',
  layers: 'Layers',
};

const DOCK_LABELS: Record<DockSide, string> = {
  left: 'Left',
  right: 'Right',
};

export function LayoutSettings() {
  const layout = useUIPreferencesStore((s) => s.layout);
  const setDefaultLayout = useUIPreferencesStore((s) => s.setDefaultLayout);
  const setPanelDockFor = useUIPreferencesStore((s) => s.setPanelDockFor);
  const setPanelVisibleFor = useUIPreferencesStore((s) => s.setPanelVisibleFor);
  const togglePinFor = useUIPreferencesStore((s) => s.togglePinFor);
  const resetLayoutCustomization = useUIPreferencesStore((s) => s.resetLayoutCustomization);

  const handleReset = () => {
    const ok = window.confirm(
      'Reset all layout customization across all four layouts? This also forgets per-document layout memory. Cannot be undone.'
    );
    if (ok) resetLayoutCustomization();
  };

  return (
    <div className="layout-settings">
      <header className="layout-settings-header">
        <h3>Layout</h3>
        <p>
          Customize how each layout arranges its panels. Changes are scoped to
          the layout you're editing — switching to another layout never carries
          unexpected state with it.
        </p>
      </header>

      <section className="layout-settings-section">
        <h4>Default layout for new documents</h4>
        <div className="layout-settings-default-row">
          {LAYOUT_MODES.map((mode) => (
            <label key={mode} className={`layout-settings-default-option ${layout.defaultMode === mode ? 'active' : ''}`}>
              <input
                type="radio"
                name="default-layout"
                value={mode}
                checked={layout.defaultMode === mode}
                onChange={() => setDefaultLayout(mode)}
              />
              <LayoutThumbnail mode={mode} active={layout.defaultMode === mode} />
              <div className="layout-settings-default-text">
                <div className="layout-settings-default-name">{LAYOUT_LABELS[mode]}</div>
                <div className="layout-settings-default-desc">{LAYOUT_DESCRIPTIONS[mode]}</div>
              </div>
            </label>
          ))}
        </div>
      </section>

      {LAYOUT_MODES.map((mode) => (
        <LayoutEditor
          key={mode}
          mode={mode}
          overrides={layout.modeOverrides[mode]}
          onSetDock={(panel, dock) => setPanelDockFor(mode, panel, dock)}
          onSetVisible={(panel, visible) => setPanelVisibleFor(mode, panel, visible)}
          onTogglePin={(panel) => togglePinFor(mode, panel)}
        />
      ))}

      <section className="layout-settings-section">
        <h4>Reset</h4>
        <button type="button" className="layout-settings-reset" onClick={handleReset}>
          Reset all layout customization
        </button>
      </section>
    </div>
  );
}

interface LayoutEditorProps {
  mode: LayoutMode;
  overrides: Partial<Record<PanelId, PanelState>>;
  onSetDock: (panel: PanelId, dock: DockSide) => void;
  onSetVisible: (panel: PanelId, visible: boolean) => void;
  onTogglePin: (panel: PanelId) => void;
}

function LayoutEditor({ mode, overrides, onSetDock, onSetVisible, onTogglePin }: LayoutEditorProps) {
  return (
    <section className="layout-settings-section">
      <div className="layout-settings-mode-header">
        <LayoutThumbnail mode={mode} width={64} height={40} />
        <div>
          <h4>{LAYOUT_LABELS[mode]}</h4>
          <p className="layout-settings-mode-desc">{LAYOUT_DESCRIPTIONS[mode]}</p>
        </div>
      </div>
      <table className="layout-settings-table">
        <thead>
          <tr>
            <th>Panel</th>
            <th>Visible</th>
            <th>Dock</th>
            <th>Pinned</th>
          </tr>
        </thead>
        <tbody>
          {PANEL_IDS.map((panel) => {
            const state = resolvePanelState(mode, panel, overrides[panel]);
            const preset = LAYOUT_PRESETS[mode][panel];
            const hasOverride = overrides[panel] !== undefined;
            return (
              <tr key={panel}>
                <td>
                  {PANEL_LABELS[panel]}
                  {hasOverride && (
                    <span className="layout-settings-customized" title={`Default: ${preset.visible ? DOCK_LABELS[preset.dock] : 'hidden'}`}>
                      • customized
                    </span>
                  )}
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={state.visible}
                    onChange={(e) => onSetVisible(panel, e.target.checked)}
                  />
                </td>
                <td>
                  <select
                    value={state.dock}
                    onChange={(e) => onSetDock(panel, e.target.value as DockSide)}
                    disabled={!state.visible}
                  >
                    <option value="left">Left</option>
                    <option value="right">Right</option>
                  </select>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={state.pinned ?? false}
                    onChange={() => onTogglePin(panel)}
                    disabled={!state.visible}
                    title={!state.visible ? 'Pin only applies when the panel is visible' : 'Pin this panel open (skips fly-out auto-collapse)'}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
