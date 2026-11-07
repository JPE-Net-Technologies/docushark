/**
 * The properties panel and undo in a local document (DSK-229). Local documents undo
 * by snapshot, and only a recorded step makes one, so a panel edit that records none
 * is swept up with whatever came before: undoing it removed the shape it was made to.
 * Real panel and stores.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '../shapes/Rectangle';
import '../shapes/Group';
import { shapeRegistry } from '../shapes/ShapeRegistry';
import { createLibraryShapeHandler } from '../shapes/library/LibraryShapeHandler';
import { activityActionShape } from '../shapes/library/activityDiagramShapes';
import { erdEntityShape } from '../shapes/library/erdShapes';
import { PropertyPanel } from './PropertyPanel';
import { useDocumentStore } from '../store/documentStore';
import { useHistoryStore } from '../store/historyStore';
import { usePageStore } from '../store/pageStore';
import { useSessionStore } from '../store/sessionStore';
import type { Shape } from '../shapes/Shape';

function rect(id = 'a', extra: object = {}): Shape {
  return {
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
  } as unknown as Shape;
}

const shape = (id = 'a') => useDocumentStore.getState().shapes[id];
const later = (ms = 1000) => vi.setSystemTime(Date.now() + ms);
const undo = () => act(() => useHistoryStore.getState().undo());
const redo = () => act(() => useHistoryStore.getState().redo());
const opacitySlider = () => document.querySelector('.property-quick-bar input[type="range"]') as HTMLInputElement;
const setOpacity = (value: number) => fireEvent.change(opacitySlider(), { target: { value: String(value) } });

/** A shape as a tool draws one: a recorded step, then the shape. */
function draw(drawn: Shape) {
  useHistoryStore.getState().push('Create shape');
  useDocumentStore.getState().addShape(drawn);
  later();
}

function show(...ids: string[]) {
  act(() => useSessionStore.getState().select(ids));
  return render(<PropertyPanel />);
}

// Only ever forward: the helper remembers its last edit between tests.
let clock = Date.parse('2026-11-06T00:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clock += 3_600_000;
  vi.setSystemTime(clock);
  usePageStore.getState().reset();
  useDocumentStore.getState().clear();
  useHistoryStore.setState({ pageHistory: {}, activePageId: null, isTracking: true });
  act(() => useSessionStore.getState().clearSelection());
  const page = usePageStore.getState().createPage('Page');
  usePageStore.getState().setActivePage(page);
  useHistoryStore.getState().setActivePage(page);
  later();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('undo after an edit in the panel', () => {
  it('undoes the edit and keeps the shape, and a second undo removes the shape', () => {
    draw(rect());
    show('a');
    setOpacity(0.5);
    undo();
    expect(shape()?.opacity).toBe(1);
    undo();
    expect(shape()).toBeUndefined();
  });

  it('comes back with redo', () => {
    draw(rect());
    show('a');
    setOpacity(0.5);
    undo();
    redo();
    expect(shape()?.opacity).toBe(0.5);
  });

  it('treats a drag as one step, however long it lasts', () => {
    draw(rect());
    show('a');
    for (let value = 0.9; value > 0.1; value -= 0.02) {
      setOpacity(value);
      later(16);
    }
    expect(shape()?.opacity).toBeLessThan(0.2);
    undo();
    expect(shape()?.opacity).toBe(1);
  });

  it('treats two edits with a pause between them as two steps', () => {
    draw(rect());
    show('a');
    setOpacity(0.5);
    later();
    setOpacity(0.25);
    undo();
    expect(shape()?.opacity).toBe(0.5);
    undo();
    expect(shape()?.opacity).toBe(1);
    expect(shape()).toBeDefined();
  });

  it('keeps recording when the clock is set back', () => {
    draw(rect());
    show('a');
    setOpacity(0.5);
    later(-3_600_000);
    setOpacity(0.25);
    undo();
    expect(shape()?.opacity).toBe(0.5);
  });

  it('undoes an edit to several shapes as one step', () => {
    draw(rect('a'));
    draw(rect('b'));
    show('a', 'b');
    setOpacity(0.5);
    expect(shape('a')?.opacity).toBe(0.5);
    expect(shape('b')?.opacity).toBe(0.5);
    undo();
    expect(shape('a')?.opacity).toBe(1);
    expect(shape('b')?.opacity).toBe(1);
  });
});

describe('every path through the panel records it', () => {
  it('in a group', () => {
    draw(rect('a'));
    draw({
      id: 'g',
      type: 'group',
      x: 0,
      y: 0,
      rotation: 0,
      opacity: 1,
      locked: false,
      visible: true,
      fill: null,
      stroke: null,
      strokeWidth: 0,
      childIds: ['a'],
    } as unknown as Shape);
    show('g');
    fireEvent.change(screen.getByRole('slider'), { target: { value: '0.5' } });
    expect(shape('g')?.opacity).toBe(0.5);
    undo();
    expect(shape('g')?.opacity).toBe(1);
    expect(shape('g')).toBeDefined();
  });

  it('on a library shape', () => {
    if (!shapeRegistry.hasHandler(activityActionShape.type)) {
      shapeRegistry.register(
        activityActionShape.type,
        createLibraryShapeHandler(activityActionShape),
        activityActionShape.metadata,
      );
    }
    draw(rect('lib', { type: activityActionShape.type }));
    show('lib');
    setOpacity(0.5);
    undo();
    expect(shape('lib')?.opacity).toBe(1);
  });

  it('in a section of its own, such as an ERD table', () => {
    if (!shapeRegistry.hasHandler(erdEntityShape.type)) {
      shapeRegistry.register(erdEntityShape.type, createLibraryShapeHandler(erdEntityShape), erdEntityShape.metadata);
    }
    draw(rect('erd', { type: erdEntityShape.type, customProperties: { attributePaddingHorizontal: 4 } }));
    const view = show('erd');
    const padding = view.container.querySelectorAll('input.styled-number-input');
    fireEvent.change(padding[0]!, { target: { value: '9' } });
    const data = () => (shape('erd') as unknown as { customProperties: Record<string, unknown> }).customProperties;
    expect(data()['attributePaddingHorizontal']).toBe(9);
    undo();
    expect(data()['attributePaddingHorizontal']).toBe(4);
  });
});
