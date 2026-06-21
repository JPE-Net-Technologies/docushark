import { beforeEach, describe, expect, it } from 'vitest';
import { useUIPreferencesStore } from './uiPreferencesStore';
import { LAYOUT_PRESETS, resolvePanelState } from '../ui/layout/modes';

const STORAGE_KEY = 'docushark-ui-preferences';
const LEGACY_SPLIT_PANE_KEY = 'docushark-split-pane-width';

beforeEach(() => {
  localStorage.clear();
  useUIPreferencesStore.getState().reset();
});

describe('uiPreferencesStore — layout slice', () => {
  it('starts with Relaxed default (app-level), no overrides, native chrome', () => {
    const { layout } = useUIPreferencesStore.getState();
    expect(layout.defaultMode).toBe('relaxed');
    expect(layout.modeOverrides).toEqual({
      relaxed: {},
      designer: {},
      technician: {},
      power: {},
    });
    expect(layout.customChrome).toBe(false);
    // Layout is app-level — there is no per-document map.
    expect('perDoc' in layout).toBe(false);
  });

  it('setDefaultLayout sets the single app-level active layout', () => {
    useUIPreferencesStore.getState().setDefaultLayout('power');
    expect(useUIPreferencesStore.getState().layout.defaultMode).toBe('power');
  });

  it('setPanelDockFor scopes overrides to the named layout only', () => {
    useUIPreferencesStore.getState().setPanelDockFor('technician', 'properties', 'left');
    const { layout } = useUIPreferencesStore.getState();
    expect(layout.modeOverrides.technician.properties?.dock).toBe('left');
    expect(layout.modeOverrides.power.properties).toBeUndefined();
  });

  it('setPanelVisibleFor flips visibility without touching dock side', () => {
    const s = useUIPreferencesStore.getState();
    s.setPanelDockFor('power', 'document', 'right');
    s.setPanelVisibleFor('power', 'document', false);
    const after = useUIPreferencesStore.getState().layout.modeOverrides.power.document;
    expect(after?.dock).toBe('right');
    expect(after?.visible).toBe(false);
    s.setPanelVisibleFor('power', 'document', true);
    expect(useUIPreferencesStore.getState().layout.modeOverrides.power.document?.dock).toBe('right');
    expect(useUIPreferencesStore.getState().layout.modeOverrides.power.document?.visible).toBe(true);
  });

  it('togglePinFor flips pinned state and preserves dock+order', () => {
    const s = useUIPreferencesStore.getState();
    s.setPanelDockFor('designer', 'properties', 'right');
    s.togglePinFor('designer', 'properties');
    expect(useUIPreferencesStore.getState().layout.modeOverrides.designer.properties?.pinned).toBe(true);
    s.togglePinFor('designer', 'properties');
    expect(useUIPreferencesStore.getState().layout.modeOverrides.designer.properties?.pinned).toBe(false);
    expect(useUIPreferencesStore.getState().layout.modeOverrides.designer.properties?.dock).toBe('right');
  });

  it('setPanelWidthFor only updates width, not dock/order', () => {
    useUIPreferencesStore.getState().setPanelDockFor('power', 'properties', 'left');
    useUIPreferencesStore.getState().setPanelWidthFor('power', 'properties', 360);
    const entry = useUIPreferencesStore.getState().layout.modeOverrides.power.properties;
    expect(entry?.dock).toBe('left');
    expect(entry?.width).toBe(360);
  });

  it('setCustomChrome toggles the chrome opt-in', () => {
    useUIPreferencesStore.getState().setCustomChrome(true);
    expect(useUIPreferencesStore.getState().layout.customChrome).toBe(true);
    useUIPreferencesStore.getState().setCustomChrome(false);
    expect(useUIPreferencesStore.getState().layout.customChrome).toBe(false);
  });

  it('resetLayoutCustomization clears overrides, keeps default + chrome', () => {
    const s = useUIPreferencesStore.getState();
    s.setDefaultLayout('technician');
    s.setCustomChrome(true);
    s.setPanelDockFor('power', 'properties', 'left');
    s.resetLayoutCustomization();
    const { layout } = useUIPreferencesStore.getState();
    expect(layout.defaultMode).toBe('technician');
    expect(layout.customChrome).toBe(true);
    expect(layout.modeOverrides.power).toEqual({});
  });
});

describe('uiPreferencesStore — document browser grouping', () => {
  it('accepts the collection grouping mode', () => {
    useUIPreferencesStore.getState().setDocumentBrowserGroupBy('collection');
    expect(useUIPreferencesStore.getState().documentBrowserGroupBy).toBe('collection');
  });
});

describe('layout presets', () => {
  it('every layout has an entry for every panel id', () => {
    for (const mode of ['relaxed', 'designer', 'technician', 'power'] as const) {
      expect(LAYOUT_PRESETS[mode]).toHaveProperty('document');
      expect(LAYOUT_PRESETS[mode]).toHaveProperty('properties');
      expect(LAYOUT_PRESETS[mode]).toHaveProperty('layers');
    }
  });

  it('Relaxed hides properties, Power pins them', () => {
    expect(LAYOUT_PRESETS.relaxed.properties.visible).toBe(false);
    expect(LAYOUT_PRESETS.power.properties.pinned).toBe(true);
  });

  it('Relaxed is writing-first: document fills the region (no fixed width), layers hidden', () => {
    expect(LAYOUT_PRESETS.relaxed.document.visible).toBe(true);
    expect(LAYOUT_PRESETS.relaxed.document.width).toBeUndefined();
    expect(LAYOUT_PRESETS.relaxed.layers.visible).toBe(false);
  });

  it('Designer hides the document panel (canvas-immersive) but preserves the dock side', () => {
    expect(LAYOUT_PRESETS.designer.document.visible).toBe(false);
    expect(LAYOUT_PRESETS.designer.document.dock).toBe('left');
  });

  it('resolvePanelState merges overrides on top of presets', () => {
    const merged = resolvePanelState('technician', 'properties', { dock: 'left', visible: true, order: 0 });
    expect(merged.dock).toBe('left');
    // Width comes from preset since override didn't set it.
    expect(merged.width).toBe(LAYOUT_PRESETS.technician.properties.width);
  });

  it('resolvePanelState with no override returns the preset unchanged', () => {
    const preset = LAYOUT_PRESETS.power.layers;
    expect(resolvePanelState('power', 'layers', undefined)).toEqual(preset);
  });
});

describe('uiPreferencesStore — migration', () => {
  it('v1 → v2 collapses dock="hidden" into visible=false while preserving the user dock side', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          expandedSections: {},
          propertyPanelWidth: 240,
          documentBrowserView: 'list',
          documentBrowserSort: 'modified-desc',
          documentBrowserGroupBy: 'none',
          documentBrowserCollapsed: {},
          layout: {
            defaultMode: 'relaxed',
            perDoc: {},
            modeOverrides: {
              relaxed: {},
              designer: { document: { dock: 'hidden', order: 0 } },
              technician: { properties: { dock: 'left', order: 0, width: 300 } },
              power: { document: { dock: 'right', order: 0 } },
            },
            customChrome: false,
          },
        },
        version: 1,
      })
    );

    await useUIPreferencesStore.persist.rehydrate();

    const { layout } = useUIPreferencesStore.getState();
    // Designer had dock:'hidden' → visible: false, dock falls back to preset side (left)
    expect(layout.modeOverrides.designer.document?.visible).toBe(false);
    expect(layout.modeOverrides.designer.document?.dock).toBe('left');
    // Technician had a real side override → preserved + visible:true default
    expect(layout.modeOverrides.technician.properties?.dock).toBe('left');
    expect(layout.modeOverrides.technician.properties?.visible).toBe(true);
    expect(layout.modeOverrides.technician.properties?.width).toBe(300);
    // Power had document on the right → preserved
    expect(layout.modeOverrides.power.document?.dock).toBe('right');
    expect(layout.modeOverrides.power.document?.visible).toBe(true);
  });

  it('adopts the legacy split-pane width into the document panel override on hydration', async () => {
    localStorage.setItem(LEGACY_SPLIT_PANE_KEY, '420');
    // Simulate a stored v0 preferences payload with no layout slice.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          expandedSections: {},
          propertyPanelWidth: 240,
          documentBrowserView: 'list',
          documentBrowserSort: 'modified-desc',
          documentBrowserGroupBy: 'none',
          documentBrowserCollapsed: {},
        },
        version: 0,
      })
    );

    // Force the persist middleware to re-read localStorage and run the v0→v1
    // migrate callback against the fixture above.
    await useUIPreferencesStore.persist.rehydrate();

    const { layout } = useUIPreferencesStore.getState();
    expect(layout.modeOverrides.relaxed.document?.width).toBe(420);
    expect(layout.modeOverrides.power.document?.width).toBe(420);
  });

  it('v2 → v3 drops the per-document perDoc map, preserving the default mode + overrides', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          expandedSections: {},
          propertyPanelWidth: 240,
          documentBrowserView: 'list',
          documentBrowserSort: 'modified-desc',
          documentBrowserGroupBy: 'none',
          documentBrowserCollapsed: {},
          layout: {
            defaultMode: 'technician',
            perDoc: { 'doc-1': 'power', 'doc-2': 'designer' },
            modeOverrides: {
              relaxed: {},
              designer: {},
              technician: { properties: { dock: 'left', visible: true, order: 0 } },
              power: {},
            },
            customChrome: true,
          },
        },
        version: 2,
      })
    );

    await useUIPreferencesStore.persist.rehydrate();

    const { layout } = useUIPreferencesStore.getState();
    // perDoc is gone; the app-level default + overrides + chrome survive.
    expect('perDoc' in layout).toBe(false);
    expect(layout.defaultMode).toBe('technician');
    expect(layout.customChrome).toBe(true);
    expect(layout.modeOverrides.technician.properties?.dock).toBe('left');
  });

  it('v3 → v4 defaults the new appearance slice without disturbing layout', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          expandedSections: {},
          propertyPanelWidth: 240,
          documentBrowserView: 'list',
          documentBrowserSort: 'modified-desc',
          documentBrowserGroupBy: 'none',
          documentBrowserCollapsed: {},
          layout: { defaultMode: 'power', modeOverrides: { relaxed: {}, designer: {}, technician: {}, power: {} }, customChrome: false },
          // No appearancePrefs — predates the v4 slice.
        },
        version: 3,
      })
    );

    await useUIPreferencesStore.persist.rehydrate();

    const state = useUIPreferencesStore.getState();
    expect(state.appearancePrefs).toEqual({
      themeInputs: { light: {}, dark: {} },
      motion: 'system',
      density: 'normal',
      uiScale: 1,
      proseBackground: 'default',
    });
    // Layout from the older payload is untouched.
    expect(state.layout.defaultMode).toBe('power');
  });

  it('v4 → v6 migrates accent → custom Primary and fills density/uiScale', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          layout: { defaultMode: 'relaxed', modeOverrides: { relaxed: {}, designer: {}, technician: {}, power: {} }, customChrome: false },
          appearancePrefs: { accent: 'teal', motion: 'reduced' }, // v4 shape (accent enum)
        },
        version: 4,
      })
    );

    await useUIPreferencesStore.persist.rehydrate();

    // accent → primary (both bases, JP-255 teal hexes); motion preserved; rest defaulted.
    expect(useUIPreferencesStore.getState().appearancePrefs).toEqual({
      themeInputs: { light: { primary: '#0f766e' }, dark: { primary: '#5eead4' } },
      motion: 'reduced',
      density: 'normal',
      uiScale: 1,
      proseBackground: 'default',
    });
  });

  it("v5 → v6 with accent 'default' yields empty custom-theme inputs", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          layout: { defaultMode: 'relaxed', modeOverrides: { relaxed: {}, designer: {}, technician: {}, power: {} }, customChrome: false },
          appearancePrefs: { accent: 'default', motion: 'system', density: 'compact', uiScale: 1.1 }, // v5 shape
        },
        version: 5,
      })
    );

    await useUIPreferencesStore.persist.rehydrate();

    expect(useUIPreferencesStore.getState().appearancePrefs).toEqual({
      themeInputs: { light: {}, dark: {} },
      motion: 'system',
      density: 'compact',
      uiScale: 1.1,
      proseBackground: 'default',
    });
  });

  it('v7 → v8 defaults the floating collab-indicator position to null', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          layout: { defaultMode: 'relaxed', modeOverrides: { relaxed: {}, designer: {}, technician: {}, power: {} }, customChrome: false },
          // v7 payload has no collabIndicatorPos field.
        },
        version: 7,
      })
    );

    await useUIPreferencesStore.persist.rehydrate();

    expect(useUIPreferencesStore.getState().collabIndicatorPos).toBeNull();
  });

  it('v8 → v9 resets the legacy 480px split width to the responsive null default', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          layout: { defaultMode: 'relaxed', modeOverrides: { relaxed: {}, designer: {}, technician: {}, power: {} }, customChrome: false },
          relaxedSplitCanvasWidth: 480, // the old hard default
        },
        version: 8,
      })
    );

    await useUIPreferencesStore.persist.rehydrate();

    expect(useUIPreferencesStore.getState().relaxedSplitCanvasWidth).toBeNull();
  });

  it('v8 → v9 preserves a deliberately-dragged split width', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          layout: { defaultMode: 'relaxed', modeOverrides: { relaxed: {}, designer: {}, technician: {}, power: {} }, customChrome: false },
          relaxedSplitCanvasWidth: 640, // a value the user dragged to
        },
        version: 8,
      })
    );

    await useUIPreferencesStore.persist.rehydrate();

    expect(useUIPreferencesStore.getState().relaxedSplitCanvasWidth).toBe(640);
  });
});

describe('uiPreferencesStore — collab indicator position', () => {
  it('defaults to null and pins on set', () => {
    expect(useUIPreferencesStore.getState().collabIndicatorPos).toBeNull();
    useUIPreferencesStore.getState().setCollabIndicatorPos({ x: 120, y: 64 });
    expect(useUIPreferencesStore.getState().collabIndicatorPos).toEqual({ x: 120, y: 64 });
  });
});

describe('uiPreferencesStore — appearance slice', () => {
  it('defaults to the base theme (no overrides), system motion, normal density, scale 1', () => {
    expect(useUIPreferencesStore.getState().appearancePrefs).toEqual({
      themeInputs: { light: {}, dark: {} },
      motion: 'system',
      density: 'normal',
      uiScale: 1,
      proseBackground: 'default',
    });
  });

  it('setThemeInput sets/clears a slot per base without touching the other base', () => {
    const s = useUIPreferencesStore.getState();
    s.setThemeInput('light', 'primary', '#123456');
    expect(useUIPreferencesStore.getState().appearancePrefs.themeInputs).toEqual({
      light: { primary: '#123456' },
      dark: {},
    });
    s.setThemeInput('light', 'primary', undefined);
    expect(useUIPreferencesStore.getState().appearancePrefs.themeInputs.light).toEqual({});
  });

  it('setMotion / setDensity update the slice (new ref each time)', () => {
    const s = useUIPreferencesStore.getState();
    const before = s.appearancePrefs;
    s.setMotion('reduced');
    s.setDensity('compact');
    const after = useUIPreferencesStore.getState().appearancePrefs;
    expect(after.motion).toBe('reduced');
    expect(after.density).toBe('compact');
    expect(after).not.toBe(before);
  });

  it('setUiScale clamps to the supported range', () => {
    const s = useUIPreferencesStore.getState();
    s.setUiScale(5);
    expect(useUIPreferencesStore.getState().appearancePrefs.uiScale).toBe(1.25);
    s.setUiScale(0.1);
    expect(useUIPreferencesStore.getState().appearancePrefs.uiScale).toBe(0.9);
    s.setUiScale(1.1);
    expect(useUIPreferencesStore.getState().appearancePrefs.uiScale).toBe(1.1);
  });
});
