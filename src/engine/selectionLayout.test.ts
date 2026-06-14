import { describe, it, expect, beforeEach } from 'vitest';
import '../shapes/Rectangle'; // registers the handler computeAutoLayout reads for sizing
import { useDocumentStore } from '../store/documentStore';
import { useSessionStore } from '../store/sessionStore';
import {
  selectConnectedChain,
  autoLayoutSelection,
  canSelectConnectedChain,
  canAutoLayoutSelection,
} from './selectionLayout';
import { DEFAULT_RECTANGLE, DEFAULT_CONNECTOR, type Shape } from '../shapes/Shape';

function node(id: string, x: number, y: number): Shape {
  return { ...DEFAULT_RECTANGLE, id, type: 'rectangle', x, y, width: 100, height: 60 } as Shape;
}

function conn(id: string, from: string, to: string): Shape {
  return {
    ...DEFAULT_CONNECTOR,
    id,
    type: 'connector',
    x: 0,
    y: 0,
    x2: 0,
    y2: 0,
    startShapeId: from,
    endShapeId: to,
  } as Shape;
}

describe('selectionLayout actions (JP-305 Slice D)', () => {
  beforeEach(() => {
    useDocumentStore.getState().clear();
    useSessionStore.getState().clearSelection();
  });

  it('selectConnectedChain expands the selection to the whole chain', () => {
    useDocumentStore.getState().addShapes([
      node('a', 0, 0), node('b', 0, 200), node('c', 0, 400),
      conn('c1', 'a', 'b'), conn('c2', 'b', 'c'),
    ]);
    useSessionStore.getState().select(['a']);
    selectConnectedChain();
    expect(useSessionStore.getState().getSelectedIds().sort()).toEqual(['a', 'b', 'c', 'c1', 'c2']);
  });

  it('selectConnectedChain is a no-op with nothing selected', () => {
    selectConnectedChain();
    expect(useSessionStore.getState().getSelectedIds()).toEqual([]);
  });

  it('autoLayoutSelection ranks a connected selection top-to-bottom', () => {
    useDocumentStore.getState().addShapes([node('a', 500, 0), node('b', 0, 300), conn('c1', 'a', 'b')]);
    useSessionStore.getState().select(['a', 'b']);
    autoLayoutSelection('TB');
    const s = useDocumentStore.getState().shapes;
    expect(s['a']!.y).toBeLessThan(s['b']!.y);
  });

  it('autoLayoutSelection LR flows along x on a shared row', () => {
    useDocumentStore.getState().addShapes([node('a', 0, 0), node('b', 0, 500), conn('c1', 'a', 'b')]);
    useSessionStore.getState().select(['a', 'b']);
    autoLayoutSelection('LR');
    const s = useDocumentStore.getState().shapes;
    expect(s['a']!.x).toBeLessThan(s['b']!.x);
    expect(Math.abs(s['a']!.y - s['b']!.y)).toBeLessThan(1);
  });

  it('guards reflect the selection size', () => {
    expect(canSelectConnectedChain()).toBe(false);
    expect(canAutoLayoutSelection()).toBe(false);

    useDocumentStore.getState().addShapes([node('a', 0, 0), node('b', 0, 0)]);
    useSessionStore.getState().select(['a']);
    expect(canSelectConnectedChain()).toBe(true);
    expect(canAutoLayoutSelection()).toBe(false);

    useSessionStore.getState().select(['a', 'b']);
    expect(canAutoLayoutSelection()).toBe(true);
  });
});
