/**
 * The canvas selection bar (DSK-225). Real stores and profile actions. The colour
 * input is a stand-in here, as the picker has tests of its own and only what the bar
 * does with a colour matters.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';

const h = vi.hoisted(() => ({ phone: false, readOnly: false }));

vi.mock('../layout/useMobileAdaptation', () => ({ useMobileAdaptation: () => ({ mobileActive: h.phone }) }));
vi.mock('../layout/useBreakpoint', () => ({ useBreakpoint: () => ({ band: 'wide' }) }));
vi.mock('../../store/documentRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/documentRegistry')>();
  return { ...actual, useActiveDocReadOnly: () => h.readOnly };
});
vi.mock('../CompactColorInput', () => ({
  CompactColorInput: ({
    label,
    value,
    onChange,
    showNoFill,
  }: {
    label: string;
    value: string;
    onChange: (color: string) => void;
    showNoFill?: boolean;
  }) => (
    <button
      type="button"
      aria-label={label}
      data-color={value}
      data-no-fill={String(!!showNoFill)}
      onClick={() => onChange('#000001')}
    />
  ),
}));

import '../../shapes/Rectangle';
import '../../shapes/Group';
import '../../shapes/Line';
import '../../shapes/Connector';
import '../../shapes/Text';
import { useDocumentStore } from '../../store/documentStore';
import { useHistoryStore } from '../../store/historyStore';
import { usePageStore } from '../../store/pageStore';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useStyleProfileStore } from '../../store/styleProfileStore';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';
import type { Shape } from '../../shapes/Shape';
import { registerCanvasFocus } from '../layout/focusRegions';
import { CanvasSelectionBar } from './CanvasSelectionBar';

const GREEN = 'Fresh Green';
const ORANGE = 'Warm Orange';
const GRAY = 'Subtle Gray';

const profile = (name: string) => useStyleProfileStore.getState().profiles.find((item) => item.name === name)!;

function add(id: string, extra: object = {}) {
  useDocumentStore.getState().addShape({
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#123456',
    stroke: '#654321',
    strokeWidth: 3,
    cornerRadius: 1,
    ...extra,
  } as unknown as Shape);
}

const shape = (id = 'a') => useDocumentStore.getState().shapes[id]!;
const select = (...ids: string[]) => act(() => useSessionStore.getState().select(ids));
const bar = () => screen.queryByRole('toolbar', { name: 'Selection' });
const later = (ms = 1000) => vi.setSystemTime(Date.now() + ms);
const undo = () => act(() => useHistoryStore.getState().undo());
const swatches = () =>
  screen.queryAllByRole('button', { name: /^Apply / }).map((button) => button.getAttribute('aria-label')!.slice(6));
const apply = (name: string) => screen.getByRole('button', { name: `Apply ${name}` });
const previewing = () => Object.keys(useSessionStore.getState().stylePreviewOverrides);

const show = (width = 800, height = 600) => render(<CanvasSelectionBar canvasWidth={width} canvasHeight={height} />);

// Only ever forward: the history helper remembers its last edit between tests.
let clock = Date.parse('2026-11-07T00:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clock += 3_600_000;
  vi.setSystemTime(clock);
  h.phone = false;
  h.readOnly = false;
  usePageStore.getState().reset();
  useDocumentStore.getState().clear();
  useHistoryStore.setState({ pageHistory: {}, activePageId: null, isTracking: true });
  const page = usePageStore.getState().createPage('Page');
  usePageStore.getState().setActivePage(page);
  useHistoryStore.getState().setActivePage(page);
  act(() => {
    useSessionStore.getState().clearSelection();
    useSessionStore.setState({
      relaxedFocus: 'diagram',
      activeTool: 'select',
      editingTextId: null,
      camera: { x: 0, y: 0, zoom: 1 },
      propertiesRequested: false,
    });
  });
  useSettingsStore.setState({ showSelectionBar: true, hideDefaultStyleProfiles: false });
  useStyleProfileStore.setState({ recentProfileIds: [] });
  useUIPreferencesStore.getState().setDefaultLayout('relaxed');
  later();
  add('a');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('when the bar shows', () => {
  it('shows for a selection, and not without one', () => {
    show();
    expect(bar()).toBeNull();
    select('a');
    expect(bar()).not.toBeNull();
    act(() => useSessionStore.getState().clearSelection());
    expect(bar()).toBeNull();
  });

  it('waits while a drawing tool is in hand', () => {
    show();
    select('a');
    act(() => useSessionStore.getState().setActiveTool('rectangle'));
    expect(bar()).toBeNull();
  });

  it('keeps out of a text edit', () => {
    show();
    select('a');
    act(() => useSessionStore.getState().startTextEdit('a'));
    expect(bar()).toBeNull();
    act(() => useSessionStore.getState().stopTextEdit());
    expect(bar()).not.toBeNull();
  });

  it('offers nothing in a document that can\'t be edited', () => {
    h.readOnly = true;
    select('a');
    show();
    expect(bar()).toBeNull();
  });

  it('leaves a phone to its own bar', () => {
    h.phone = true;
    select('a');
    show();
    expect(bar()).toBeNull();
  });

  it('has no canvas to stand on in Write focus', () => {
    act(() => useSessionStore.setState({ relaxedFocus: 'write' }));
    select('a');
    show();
    expect(bar()).toBeNull();
  });

  it('stays away when turned off', () => {
    useSettingsStore.setState({ showSelectionBar: false });
    select('a');
    show();
    expect(bar()).toBeNull();
  });

  describe('during a press on the canvas', () => {
    let canvas: HTMLCanvasElement;

    beforeEach(() => {
      canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      select('a');
      show();
    });

    afterEach(() => canvas.remove());

    it('gets out of the way until the press ends', () => {
      fireEvent.pointerDown(canvas);
      expect(bar()).toBeNull();
      fireEvent.pointerUp(window);
      expect(bar()).not.toBeNull();
    });

    it('comes back when the press is cancelled', () => {
      fireEvent.pointerDown(canvas);
      fireEvent.pointerCancel(window);
      expect(bar()).not.toBeNull();
    });

    it('comes back when the window loses focus mid-press', () => {
      fireEvent.pointerDown(canvas);
      fireEvent.blur(window);
      expect(bar()).not.toBeNull();
    });

    it('comes back for a right-click\'s menu', () => {
      fireEvent.pointerDown(canvas);
      fireEvent.contextMenu(canvas);
      expect(bar()).not.toBeNull();
    });

    it('takes no notice of a press elsewhere', () => {
      fireEvent.pointerDown(document.body);
      expect(bar()).not.toBeNull();
    });
  });
});

describe('where the bar stands', () => {
  const position = () => {
    const style = bar()!.style;
    return { left: parseFloat(style.left), top: parseFloat(style.top) };
  };

  it('stands above the selection', () => {
    select('a');
    show();
    // A rectangle's x and y are its centre. Its top edge, stroke included, is 26.5 above
    // the canvas's middle, and the bar stands 34 clear of that.
    expect(position()).toEqual({ left: 400, top: 239.5 });
  });

  it('follows the camera', () => {
    select('a');
    show();
    act(() => useSessionStore.getState().setCamera({ x: 50, y: 0 }));
    expect(position().left).toBe(350);
  });

  it('follows the shape', () => {
    select('a');
    show();
    act(() => useDocumentStore.getState().updateShape('a', { x: 100 }));
    expect(position().left).toBe(500);
  });

  it('goes when the selection is off the canvas', () => {
    select('a');
    show();
    act(() => useSessionStore.getState().setCamera({ x: 5000, y: 0 }));
    expect(bar()).toBeNull();
  });

  it('keeps out from under the panel More has opened', () => {
    act(() => useDocumentStore.getState().updateShape('a', { x: 395 }));
    select('a');
    show();
    expect(position().left).toBe(792);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    // The panel's default width, on the right, with the margin.
    expect(position().left).toBe(800 - 240 - 8);
  });
});

describe('the profiles on the bar', () => {
  it('offers three, and marks the one the selection goes with', () => {
    useDocumentStore.getState().updateShape('a', { styleProfileId: profile(GREEN).id } as Partial<Shape>);
    select('a');
    show();
    expect(swatches()).toHaveLength(3);
    const pressed = screen
      .getAllByRole('button', { name: /^Apply / })
      .filter((button) => button.getAttribute('aria-pressed') === 'true');
    expect(pressed.length).toBeLessThanOrEqual(1);
  });

  it('applies and links a profile, as one undo step', () => {
    useStyleProfileStore.setState({ recentProfileIds: [profile(GREEN).id] });
    select('a');
    show();
    fireEvent.click(apply(GREEN));
    expect(shape().fill).toBe(profile(GREEN).properties.fill);
    expect(shape().styleProfileId).toBe(profile(GREEN).id);
    expect(apply(GREEN).getAttribute('aria-pressed')).toBe('true');
    undo();
    expect(shape().fill).toBe('#123456');
    expect(shape().styleProfileId).toBeUndefined();
  });

  it('applies to every shape selected', () => {
    add('b');
    useStyleProfileStore.setState({ recentProfileIds: [profile(GREEN).id] });
    select('a', 'b');
    show();
    fireEvent.click(apply(GREEN));
    expect(shape('a').fill).toBe(profile(GREEN).properties.fill);
    expect(shape('b').fill).toBe(profile(GREEN).properties.fill);
  });

  it('leads with the profile used last, from the next selection on', () => {
    useStyleProfileStore.setState({ recentProfileIds: [profile(GREEN).id, profile(ORANGE).id] });
    add('b');
    select('a');
    show();
    expect(swatches().slice(0, 2)).toEqual([GREEN, ORANGE]);

    fireEvent.click(apply(ORANGE));
    // Not yet: the next press would land on a different profile.
    expect(swatches().slice(0, 2)).toEqual([GREEN, ORANGE]);

    select('b');
    expect(swatches().slice(0, 2)).toEqual([ORANGE, GREEN]);
  });

  it('counts a profile applied from the menu too', () => {
    select('a');
    show();
    fireEvent.click(screen.getByRole('button', { name: 'All style profiles' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'All style profiles' })).getByText(GRAY));
    expect(useStyleProfileStore.getState().recentProfileIds[0]).toBe(profile(GRAY).id);
  });

  it('previews on hover without touching the document', () => {
    useStyleProfileStore.setState({ recentProfileIds: [profile(GREEN).id] });
    select('a');
    show();
    fireEvent.mouseEnter(apply(GREEN));
    expect(previewing()).toEqual(['a']);
    expect(shape().fill).toBe('#123456');
    fireEvent.mouseLeave(apply(GREEN));
    expect(previewing()).toEqual([]);
  });

  it('previews on keyboard focus as well', () => {
    useStyleProfileStore.setState({ recentProfileIds: [profile(GREEN).id] });
    select('a');
    show();
    fireEvent.focus(apply(GREEN));
    expect(previewing()).toEqual(['a']);
    fireEvent.blur(apply(GREEN));
    expect(previewing()).toEqual([]);
  });

  it('leaves no preview behind when it goes', () => {
    useStyleProfileStore.setState({ recentProfileIds: [profile(GREEN).id] });
    select('a');
    show();
    fireEvent.mouseEnter(apply(GREEN));
    act(() => useSessionStore.getState().setActiveTool('rectangle'));
    expect(bar()).toBeNull();
    expect(previewing()).toEqual([]);
  });

  it('returns focus to the canvas after a press with the pointer', () => {
    const focus = vi.fn();
    const unregister = registerCanvasFocus(focus);
    useStyleProfileStore.setState({ recentProfileIds: [profile(GREEN).id] });
    select('a');
    show();
    fireEvent.click(apply(GREEN), { detail: 1 });
    expect(focus).toHaveBeenCalledTimes(1);
    unregister();
  });

  it('leaves focus with the keyboard', () => {
    const focus = vi.fn();
    const unregister = registerCanvasFocus(focus);
    useStyleProfileStore.setState({ recentProfileIds: [profile(GREEN).id] });
    select('a');
    show();
    fireEvent.click(apply(GREEN), { detail: 0 });
    expect(focus).not.toHaveBeenCalled();
    unregister();
  });

  describe('the menu', () => {
    const menu = () => screen.queryByRole('dialog', { name: 'All style profiles' });
    const open = () => fireEvent.click(screen.getByRole('button', { name: 'All style profiles' }));

    beforeEach(() => {
      select('a');
      show();
    });

    it('lists every profile on offer', () => {
      open();
      for (const name of [GREEN, ORANGE, GRAY]) expect(within(menu()!).getByText(name)).toBeTruthy();
    });

    it('leaves out the ones the settings hide', () => {
      act(() => useSettingsStore.setState({ hideDefaultStyleProfiles: true }));
      open();
      expect(within(menu()!).queryByText(GREEN)).toBeNull();
    });

    it('closes after applying one', () => {
      open();
      fireEvent.click(within(menu()!).getByText(GRAY));
      expect(shape().fill).toBe(profile(GRAY).properties.fill);
      expect(menu()).toBeNull();
    });

    it('closes on pressing its button again', () => {
      open();
      open();
      expect(menu()).toBeNull();
    });

    it('closes on Escape, and leaves no preview', () => {
      open();
      fireEvent.mouseEnter(within(menu()!).getByText(GRAY));
      expect(previewing()).toEqual(['a']);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(menu()).toBeNull();
      expect(previewing()).toEqual([]);
    });
  });
});

describe('the colours on the bar', () => {
  const colour = (name: string) => screen.getByRole('button', { name });

  it('shows a rectangle\'s three', () => {
    select('a');
    show();
    expect(colour('Fill').dataset['color']).toBe('#123456');
    expect(colour('Stroke').dataset['color']).toBe('#654321');
    expect(colour('Text colour').dataset['color']).toBe('#654321');
  });

  it('offers no fill on the fill alone', () => {
    select('a');
    show();
    expect(colour('Fill').dataset['noFill']).toBe('true');
    expect(colour('Stroke').dataset['noFill']).toBe('false');
    expect(colour('Text colour').dataset['noFill']).toBe('false');
  });

  it('sets each one', () => {
    select('a');
    show();
    fireEvent.click(colour('Fill'));
    expect(shape().fill).toBe('#000001');
    later();
    fireEvent.click(colour('Stroke'));
    expect(shape().stroke).toBe('#000001');
    later();
    fireEvent.click(colour('Text colour'));
    expect((shape() as unknown as { labelColor: string }).labelColor).toBe('#000001');
  });

  it('sets every shape selected, in the way each keeps it', () => {
    add('text', { type: 'text', text: 'T', fontSize: 12, fontFamily: 'serif', textAlign: 'left' });
    select('a', 'text');
    show();
    fireEvent.click(colour('Text colour (Mixed)'));
    expect((shape('a') as unknown as { labelColor: string }).labelColor).toBe('#000001');
    expect(shape('text').fill).toBe('#000001');
  });

  it('says so when the shapes differ', () => {
    add('b', { fill: '#abcdef' });
    select('a', 'b');
    show();
    expect(colour('Fill (Mixed)')).toBeTruthy();
    expect(colour('Stroke')).toBeTruthy();
  });

  it('offers no fill for a connector', () => {
    add('c', { type: 'connector', x2: 100, y2: 100, fill: null });
    select('c');
    show();
    expect(screen.queryByRole('button', { name: 'Fill' })).toBeNull();
    expect(colour('Stroke')).toBeTruthy();
  });

  it('makes a group draw the background you gave a colour', () => {
    add('g', { type: 'group', childIds: ['a'], fill: null, stroke: null });
    select('g');
    show();
    fireEvent.click(colour('Fill'));
    const group = shape('g') as unknown as { backgroundColor: string; showBackground: boolean };
    expect(group.backgroundColor).toBe('#000001');
    expect(group.showBackground).toBe(true);
  });

  it('treats a stream of changes as one undo step', () => {
    select('a');
    show();
    for (let step = 0; step < 40; step += 1) {
      fireEvent.click(colour('Fill'));
      later(16);
    }
    undo();
    expect(shape().fill).toBe('#123456');
  });

  it('treats two changes with a pause between them as two', () => {
    select('a');
    show();
    fireEvent.click(colour('Fill'));
    later();
    act(() => useDocumentStore.getState().updateShape('a', { fill: '#222222' }));
    fireEvent.click(colour('Stroke'));
    undo();
    expect(shape().stroke).toBe('#654321');
    expect(shape().fill).toBe('#222222');
  });

  it('keeps its divider for when there are colours', () => {
    add('line', { type: 'line', x2: 10, y2: 10, fill: null });
    add('t', { type: 'text', text: 'T', fontSize: 12, fontFamily: 'serif', textAlign: 'left' });
    select('line', 't');
    show();
    expect(screen.queryByRole('button', { name: 'Fill' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stroke' })).toBeNull();
    expect(bar()!.querySelectorAll('.selection-bar-divider')).toHaveLength(1);
  });
});

describe('More', () => {
  const more = () => screen.queryByRole('button', { name: 'More' });

  it('is there in a layout whose panel flies out', () => {
    act(() => useUIPreferencesStore.getState().setDefaultLayout('designer'));
    select('a');
    show();
    expect(more()).not.toBeNull();
    act(() => useUIPreferencesStore.getState().setDefaultLayout('relaxed'));
  });

  it('asks for the panel, and shows it has', () => {
    select('a');
    show();
    expect(more()!.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(more()!);
    expect(useSessionStore.getState().propertiesRequested).toBe(true);
    expect(more()!.getAttribute('aria-pressed')).toBe('true');
  });

  it('puts it away when pressed again', () => {
    select('a');
    show();
    fireEvent.click(more()!);
    fireEvent.click(more()!);
    expect(useSessionStore.getState().propertiesRequested).toBe(false);
  });

  it('is no use with the panel docked', () => {
    act(() => useUIPreferencesStore.getState().setDefaultLayout('power'));
    select('a');
    show();
    expect(bar()).not.toBeNull();
    expect(more()).toBeNull();
    act(() => useUIPreferencesStore.getState().setDefaultLayout('relaxed'));
  });
});
