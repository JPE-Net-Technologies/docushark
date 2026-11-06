/**
 * A selection on a phone (DSK-223): a tap only selects, and the properties open
 * when asked for, over the lower part of the screen, with the shape in view.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';

const h = vi.hoisted(() => ({ phone: true, readOnly: false, inset: 0, glide: vi.fn() }));

vi.mock('../layout/useMobileAdaptation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../layout/useMobileAdaptation')>()),
  useMobileAdaptation: () => ({ isMobile: h.phone, mobileActive: h.phone, accepted: h.phone, forceDesktop: false }),
}));
vi.mock('../layout/useBreakpoint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../layout/useBreakpoint')>()),
  useBreakpoint: () => ({ band: 'compact' }),
}));
vi.mock('../../store/documentRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/documentRegistry')>()),
  useActiveDocReadOnly: () => h.readOnly,
}));
vi.mock('./useKeyboardInset', () => ({ useKeyboardInset: () => h.inset }));
vi.mock('../../engine/canvasZoom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../engine/canvasZoom')>()),
  glideCamera: h.glide,
}));

import '../../shapes/Rectangle';
import '../../shapes/Group';
import { MobileSelection } from './MobileSelection';
import { PROPERTY_SHEET_TOP } from './MobilePropertySheet';
import { useDocumentStore } from '../../store/documentStore';
import { useSessionStore } from '../../store/sessionStore';
import type { RectangleShape } from '../../shapes/Shape';

function rect(id: string, y = 0): void {
  const shape: RectangleShape = {
    id,
    type: 'rectangle',
    x: 0,
    y,
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
  };
  useDocumentStore.getState().addShape(shape);
}

const select = (...ids: string[]) => act(() => useSessionStore.getState().select(ids));
const deselect = () => act(() => useSessionStore.getState().clearSelection());
const bar = () => screen.queryByRole('toolbar', { name: 'Selection' });
const sheet = () => document.querySelector<HTMLElement>('.mobile-property-sheet');
const openProperties = () => fireEvent.click(within(bar()!).getByRole('button', { name: 'Properties' }));
const selected = () => [...useSessionStore.getState().selectedIds];

let canvas: HTMLElement;

beforeEach(() => {
  h.phone = true;
  h.readOnly = false;
  h.inset = 0;
  h.glide.mockClear();
  useDocumentStore.getState().clear();
  act(() => {
    useSessionStore.getState().clearSelection();
    useSessionStore.setState({ relaxedFocus: 'diagram' });
    useSessionStore.getState().setCamera({ x: 0, y: 0, zoom: 1 });
  });
  vi.stubGlobal('innerHeight', 800);
  // A canvas 700 tall from y=100: the camera's centre is at y=450 on screen, and
  // the sheet's top edge at 0.45 x 800 = 360 on screen, 260 down the canvas.
  canvas = document.createElement('div');
  canvas.className = 'canvas-area-wrapper';
  canvas.getBoundingClientRect = () => ({ top: 100, height: 700 }) as DOMRect;
  document.body.appendChild(canvas);
});

afterEach(() => {
  cleanup();
  canvas.remove();
  vi.unstubAllGlobals();
});

describe('a tap on a phone', () => {
  it('shows nothing with nothing selected', () => {
    render(<MobileSelection />);
    expect(bar()).toBeNull();
    expect(sheet()).toBeNull();
  });

  it('only selects: a bar, and no sheet over the screen', () => {
    rect('a');
    render(<MobileSelection />);
    select('a');
    expect(within(bar()!).getByText('Rectangle')).toBeTruthy();
    expect(sheet()).toBeNull();
  });

  it('says how many shapes are selected', () => {
    rect('a');
    rect('b');
    render(<MobileSelection />);
    select('a', 'b');
    expect(within(bar()!).getByText('2 shapes')).toBeTruthy();
  });

  it('says what a group holds', () => {
    rect('a');
    rect('b');
    useDocumentStore.getState().groupShapes(['a', 'b'], 'g');
    render(<MobileSelection />);
    select('g');
    expect(within(bar()!).getByText('Group (2)')).toBeTruthy();
  });

  it('starts with the bar when it mounts on a selection, as when the layout changes', () => {
    rect('a');
    select('a');
    render(<MobileSelection />);
    expect(bar()).not.toBeNull();
    expect(sheet()).toBeNull();
  });

  it('follows to another shape of the same count', () => {
    rect('a');
    rect('b');
    rect('c');
    useDocumentStore.getState().groupShapes(['b', 'c'], 'g');
    render(<MobileSelection />);
    select('a');
    select('g');
    expect(within(bar()!).getByText('Group (2)')).toBeTruthy();
  });

  it('goes when the selection does', () => {
    rect('a');
    render(<MobileSelection />);
    select('a');
    deselect();
    expect(bar()).toBeNull();
  });

  it('stays away from a desktop', () => {
    h.phone = false;
    rect('a');
    select('a');
    render(<MobileSelection />);
    expect(bar()).toBeNull();
  });

  it('stays away from Write focus, with no canvas on screen', () => {
    rect('a');
    select('a');
    act(() => useSessionStore.setState({ relaxedFocus: 'write' }));
    render(<MobileSelection />);
    expect(bar()).toBeNull();
    expect(sheet()).toBeNull();
  });
});

describe('Delete', () => {
  it('deletes the selection', () => {
    rect('a');
    rect('b');
    render(<MobileSelection />);
    select('a');
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Delete' }));
    expect(useDocumentStore.getState().shapes['a']).toBeUndefined();
    expect(useDocumentStore.getState().shapes['b']).toBeDefined();
  });

  it('is not offered on a read-only document', () => {
    h.readOnly = true;
    rect('a');
    render(<MobileSelection />);
    select('a');
    expect(within(bar()!).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(bar()!).getByRole('button', { name: 'Properties' })).toBeTruthy();
  });
});

describe('Properties', () => {
  beforeEach(() => {
    rect('a');
    rect('b');
    render(<MobileSelection />);
    select('a');
  });

  it('opens over the lower part of the screen, leaving the rest usable', () => {
    openProperties();
    expect(bar()).toBeNull();
    expect(sheet()!.style.top).toBe(`${PROPERTY_SHEET_TOP * 100}dvh`);
    expect(sheet()!.getAttribute('aria-modal')).toBe('false');
    expect(selected()).toEqual(['a']);
  });

  it('is titled with what is selected', () => {
    openProperties();
    expect(within(sheet()!).getByText('Rectangle', { selector: '.mobile-sheet-title' })).toBeTruthy();
    select('a', 'b');
    expect(within(sheet()!).getByText('2 shapes', { selector: '.mobile-sheet-title' })).toBeTruthy();
  });

  it('closes on Done and keeps the selection', () => {
    openProperties();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(sheet()).toBeNull();
    expect(selected()).toEqual(['a']);
    expect(bar()).not.toBeNull();
  });

  it('follows to another shape', () => {
    openProperties();
    select('b');
    expect(sheet()).not.toBeNull();
  });

  it('goes when the selection does, and the next selection starts with the bar', () => {
    openProperties();
    deselect();
    expect(sheet()).toBeNull();
    select('a');
    expect(sheet()).toBeNull();
    expect(bar()).not.toBeNull();
  });

  it('takes the height above the keyboard while typing', () => {
    h.inset = 300;
    openProperties();
    expect(sheet()!.style.top).toBe('0px');
    expect(sheet()!.style.bottom).toBe('300px');
  });
});

describe('keeping the shape in view', () => {
  it('leaves the camera alone when the shape is above the sheet', () => {
    // The shape is at -300 from the camera, so 150 on screen, 50 down the canvas.
    rect('high', -300);
    render(<MobileSelection />);
    select('high');
    openProperties();
    expect(h.glide).not.toHaveBeenCalled();
  });

  it('glides a shape the sheet would cover up into the space above it', () => {
    // At y=200: 650 on screen, under the sheet. Its centre should reach the
    // middle of the 260 px left, 130 down the canvas, from 550 down it now.
    rect('low', 200);
    render(<MobileSelection />);
    select('low');
    openProperties();
    expect(h.glide).toHaveBeenCalledTimes(1);
    const target = h.glide.mock.calls[0]![0] as { x: number; y: number };
    expect(target.x).toBe(0);
    expect(target.y).toBeCloseTo(420);
  });
});
