import { useCallback, useEffect, useRef } from 'react';
import { useSessionStore } from '../store/sessionStore';
import { useDocumentStore } from '../store/documentStore';
import { pushHistory } from '../store/historyStore';
import { isText, Shape } from '../shapes/Shape';
import { shapeRegistry, type LabelEditTarget } from '../shapes/ShapeRegistry';

/**
 * Read the editable text for a shape from the target field.
 * Text shapes store `text`; all other label-bearing shapes store `label`.
 */
export function readField(shape: Shape, field: 'label' | 'text'): string {
  if (field === 'text') {
    return isText(shape) ? shape.text : '';
  }
  return (shape as { label?: string }).label ?? '';
}

/**
 * Resolve the in-place edit target for a shape via its handler capability.
 * Returns null when the shape has no editable label (JP-102 capability check).
 *
 * NOTE: handlers return a FRESH object each call, so the result is never
 * referentially stable across renders — never put it in a hook dependency
 * array (that was the root of the "label resets while typing" bug).
 */
export function getEditTarget(shape: Shape | null | undefined): LabelEditTarget | null {
  if (!shape) return null;
  const handler = shapeRegistry.getHandler(shape.type);
  return handler.getLabelEditTarget?.(shape) ?? null;
}

export interface InlineLabelEditor {
  /** The id of the shape currently being edited, or null. */
  editingTextId: string | null;
  /** Ref to attach to the editing `<textarea>`. */
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  /** Commit the draft to the shape (on blur / Enter) and end the session. */
  handleSave: () => void;
  /** Discard the draft (on Escape) and end the session. */
  handleCancel: () => void;
  /** Keydown handler implementing Enter=save, Shift+Enter=newline, Esc=cancel. */
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

/**
 * Owns the lifecycle of an inline label-edit *session*, decoupled from the
 * shape's persisted label.
 *
 * The crux: the textarea is uncontrolled and its value (the in-progress draft)
 * is **seeded exactly once per session**, keyed on `editingTextId` alone. It is
 * deliberately NOT re-derived from the shape on every render. That is what makes
 * the editor robust to the store churn that happens right after a document opens
 * or as edits are autosaved/cached/synced — those re-renders previously re-ran a
 * `textarea.value = <stored label>` assignment and wiped whatever the user had
 * typed.
 *
 * The shape/target are read fresh from the stores at session start and at save
 * time via `getState()` — never captured into a dependency array (the target
 * object is a fresh reference every call; see `getEditTarget`).
 */
export function useInlineLabelEditor(): InlineLabelEditor {
  const editingTextId = useSessionStore((state) => state.editingTextId);
  const stopTextEdit = useSessionStore((state) => state.stopTextEdit);
  const updateShape = useDocumentStore((state) => state.updateShape);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const originalTextRef = useRef<string>('');

  // Seed the draft and focus EXACTLY ONCE per edit session. Depending only on
  // `editingTextId` (not on `shape`/`target`, whose references change every
  // render) means an unrelated store write — autosave, cache round-trip, CRDT
  // sync — re-renders the editor without re-seeding the textarea, so it can no
  // longer clobber in-progress keystrokes.
  useEffect(() => {
    if (!editingTextId) return;
    const shape = useDocumentStore.getState().shapes[editingTextId];
    const target = getEditTarget(shape);
    const textarea = textareaRef.current;
    if (!shape || !target || !textarea) return;

    const text = readField(shape, target.field);
    originalTextRef.current = text;
    textarea.value = text;

    const raf = requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.select();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [editingTextId]);

  const handleSave = useCallback(() => {
    const textarea = textareaRef.current;
    if (!editingTextId || !textarea) return;

    // Read the target fresh — the shape may have moved/changed during the
    // session, but its edit field (label vs text) is stable per type.
    const shape = useDocumentStore.getState().shapes[editingTextId];
    const target = getEditTarget(shape);
    if (!shape || !target) {
      stopTextEdit();
      return;
    }

    const newText = textarea.value;
    if (newText !== originalTextRef.current) {
      pushHistory(target.field === 'text' ? 'Edit text' : 'Edit label');
      updateShape(editingTextId, { [target.field]: newText } as Partial<Shape>);
    }
    stopTextEdit();
  }, [editingTextId, updateShape, stopTextEdit]);

  const handleCancel = useCallback(() => {
    stopTextEdit();
  }, [stopTextEdit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSave();
      }
      // Shift+Enter allows newlines
    },
    [handleSave, handleCancel]
  );

  return { editingTextId, textareaRef, handleSave, handleCancel, handleKeyDown };
}
