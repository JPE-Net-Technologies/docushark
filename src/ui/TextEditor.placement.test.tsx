/**
 * Where the inline editor opens (DSK-220). A text shape's box is centred on its
 * (x, y), like every shape's, but the editor used to put its own top-left corner
 * there, so it opened half a box down and to the right of the text it edits.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { TextEditor } from './TextEditor';
import { Camera } from '../engine/Camera';
import { useSessionStore } from '../store/sessionStore';
import { useDocumentStore } from '../store/documentStore';
import { textHandler } from '../shapes/Text';
import { Vec2 } from '../math/Vec2';

afterEach(() => {
  cleanup();
  useDocumentStore.setState({ shapes: {}, shapeOrder: [] });
  useSessionStore.getState().stopTextEdit();
});

/** Edit a 200 × 50 text shape centred on (1000, 500), seen at `zoom`. */
function editText(zoom: number, rotation = 0) {
  const text = { ...textHandler.create(new Vec2(1000, 500), 't1'), rotation };
  useDocumentStore.setState({ shapes: { t1: text }, shapeOrder: ['t1'] });
  useSessionStore.getState().startTextEdit('t1');
  render(<TextEditor camera={new Camera({ x: 0, y: 0, zoom })} />);
  return document.querySelector<HTMLTextAreaElement>('.text-editor-textarea')!;
}

describe('the text editor opens over the text (DSK-220)', () => {
  it("covers the text box from the box's top-left corner", () => {
    const area = editText(1);
    expect([area.style.left, area.style.top]).toEqual(['900px', '475px']);
    expect(area.style.minHeight).toBe('50px');
  });

  it("scales with the zoom, and turns about the box's centre", () => {
    const area = editText(2, Math.PI / 6);
    expect([area.style.left, area.style.top]).toEqual(['1800px', '950px']);
    expect(area.style.transformOrigin).toBe('200px 50px');
    expect(area.style.transform).toBe(`rotate(${Math.PI / 6}rad)`);
  });
});
