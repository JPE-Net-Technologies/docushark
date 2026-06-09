/**
 * Regression guard for the "shape label resets while typing" bug.
 *
 * Root cause (now fixed): the inline label editor used an UNCONTROLLED textarea
 * whose "focus on edit start" effect re-derived `textarea.value` from the shape
 * on EVERY render. Because `<TextEditor>` is not memoized and `useAutoSave()`
 * sits at the app root force-re-rendering the whole tree on each autosave status
 * pulse (pending→saving→saved→idle) and on `isDirty`/`lastSavedAt` changes, any
 * save/cache cycle that landed while the user was typing re-ran that effect and
 * wiped the draft. The trigger was NOT a `documentStore.shapes` write — an
 * ancestor re-render with no shapes change was enough.
 *
 * The fix (`useInlineLabelEditor`) seeds the draft exactly once per edit
 * session, keyed on `editingTextId` alone, so re-renders can no longer clobber
 * in-progress keystrokes. These tests reproduce the three ways the editor gets
 * re-rendered mid-type and assert the draft survives each.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { TextEditor } from './TextEditor';
import { Camera } from '../engine/Camera';
import { useSessionStore } from '../store/sessionStore';
import { useDocumentStore } from '../store/documentStore';
import { rectangleHandler } from '../shapes/Rectangle';
import { Vec2 } from '../math/Vec2';
import type { RectangleShape } from '../shapes/Shape';

function makeRect(id: string, label: string): RectangleShape {
  const shape = rectangleHandler.create(new Vec2(100, 100), id) as RectangleShape;
  return { ...shape, label } as RectangleShape;
}

function resetStores() {
  useDocumentStore.setState({ shapes: {}, shapeOrder: [] });
  useSessionStore.getState().stopTextEdit();
}

const camera = () => new Camera({ x: 0, y: 0, zoom: 1 });

/** Wrapper exposing a bump() that re-renders <TextEditor> WITHOUT any store
 *  change — exactly what an autosave status pulse does via the root re-render. */
let bumpAncestor: () => void = () => {};
function Harness() {
  const [, setN] = useState(0);
  bumpAncestor = () => setN((n) => n + 1);
  return <TextEditor camera={camera()} />;
}

describe('TextEditor — inline label survives re-renders while typing', () => {
  beforeEach(resetStores);
  afterEach(() => {
    cleanup();
    resetStores();
  });

  it('characterizes the historical root cause: getEditTarget returns a new object each call', () => {
    const rect = makeRect('rect-1', 'Stored');
    const a = rectangleHandler.getLabelEditTarget!(rect);
    const b = rectangleHandler.getLabelEditTarget!(rect);
    // Structurally equal, different identity — putting this in an effect dep
    // array is what made the focus effect re-run (and re-seed) every render.
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('keeps in-progress typing across an ANCESTOR re-render (autosave status pulse)', () => {
    const edited = makeRect('rect-edited', 'Stored');
    act(() => {
      useDocumentStore.setState({ shapes: { [edited.id]: edited }, shapeOrder: [edited.id] });
      useSessionStore.getState().startTextEdit(edited.id);
    });

    const { container } = render(<Harness />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    // User types. fireEvent keeps React's view of the uncontrolled value honest.
    fireEvent.change(textarea, { target: { value: 'User is typing…' } });

    // The whole tree re-renders (no shapes change) — what useAutoSave's force()
    // does on every pending/saving/saved/idle transition.
    act(() => bumpAncestor());

    expect(textarea.value).toBe('User is typing…');
  });

  it('keeps in-progress typing when an UNRELATED shape updates (store write)', () => {
    const edited = makeRect('rect-edited', 'Stored');
    const other = makeRect('rect-other', 'Other');
    act(() => {
      useDocumentStore.setState({
        shapes: { [edited.id]: edited, [other.id]: other },
        shapeOrder: [edited.id, other.id],
      });
      useSessionStore.getState().startTextEdit(edited.id);
    });

    const { container } = render(<TextEditor camera={camera()} />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Half-typed' } });

    act(() => {
      useDocumentStore.getState().updateShape('rect-other', { x: 200 });
    });

    expect(textarea.value).toBe('Half-typed');
  });

  it('keeps in-progress typing when the edited shape gets a remote position update', () => {
    const edited = makeRect('rect-edited', 'Stored');
    act(() => {
      useDocumentStore.setState({ shapes: { [edited.id]: edited }, shapeOrder: [edited.id] });
      useSessionStore.getState().startTextEdit(edited.id);
    });

    const { container } = render(<TextEditor camera={camera()} />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Half-typed label' } });

    // Remote sync moves the shape; the label field is untouched.
    act(() => {
      useDocumentStore.getState().updateShape('rect-edited', { x: 350 });
    });

    expect(textarea.value).toBe('Half-typed label');
  });

  it('still commits the typed label to the shape on blur (save path intact)', () => {
    const edited = makeRect('rect-edited', 'Stored');
    act(() => {
      useDocumentStore.setState({ shapes: { [edited.id]: edited }, shapeOrder: [edited.id] });
      useSessionStore.getState().startTextEdit(edited.id);
    });

    const { container } = render(<TextEditor camera={camera()} />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Committed label' } });

    act(() => {
      fireEvent.blur(textarea);
    });

    const saved = useDocumentStore.getState().shapes['rect-edited'] as RectangleShape;
    expect(saved.label).toBe('Committed label');
    expect(useSessionStore.getState().editingTextId).toBeNull();
  });
});
