import { useEffect, useRef, useCallback } from 'react';
import { useSessionStore } from '../store/sessionStore';
import { useDocumentStore } from '../store/documentStore';
import { pushHistory } from '../store/historyStore';
import { isText, Shape } from '../shapes/Shape';
import { shapeRegistry, type LabelEditTarget } from '../shapes/ShapeRegistry';
import { Vec2 } from '../math/Vec2';
import { Camera } from '../engine/Camera';
import './TextEditor.css';

export interface TextEditorProps {
  camera: Camera | null;
}

/**
 * Read the editable text for a shape from the target field.
 * Text shapes store `text`; all other label-bearing shapes store `label`.
 */
function readField(shape: Shape, field: 'label' | 'text'): string {
  if (field === 'text') {
    return isText(shape) ? shape.text : '';
  }
  return (shape as { label?: string }).label ?? '';
}

/**
 * Resolve the in-place edit target for a shape via its handler capability.
 * Returns null when the shape has no editable label (JP-102 capability check).
 */
function getEditTarget(shape: Shape | null | undefined): LabelEditTarget | null {
  if (!shape) return null;
  const handler = shapeRegistry.getHandler(shape.type);
  return handler.getLabelEditTarget?.(shape) ?? null;
}

/**
 * Inline text editor component that overlays on the canvas.
 *
 * Editability is capability-driven: any shape whose handler returns a
 * `LabelEditTarget` can be edited in place (rectangles, ellipses, text,
 * connectors at mid-path, groups at their label anchor, library shapes). Text
 * shapes keep their bespoke top-left anchoring; every other shape is positioned
 * from the target's world rect.
 *
 * Saves changes on blur or Enter (Shift+Enter inserts a newline).
 */
export function TextEditor({ camera }: TextEditorProps) {
  const editingTextId = useSessionStore((state) => state.editingTextId);
  const stopTextEdit = useSessionStore((state) => state.stopTextEdit);
  const shapes = useDocumentStore((state) => state.shapes);
  const updateShape = useDocumentStore((state) => state.updateShape);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const originalTextRef = useRef<string>('');

  const shape = editingTextId ? shapes[editingTextId] : null;
  const target = getEditTarget(shape);
  const canEdit = !!shape && target !== null;

  // Focus the textarea when editing starts.
  useEffect(() => {
    if (canEdit && shape && target && textareaRef.current) {
      const text = readField(shape, target.field);
      originalTextRef.current = text;
      textareaRef.current.value = text;
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.select();
        }
      });
    }
  }, [canEdit, shape, target, editingTextId]);

  const handleSave = useCallback(() => {
    if (!editingTextId || !textareaRef.current || !shape || !target) return;

    const newText = textareaRef.current.value;
    if (newText !== originalTextRef.current) {
      pushHistory(target.field === 'text' ? 'Edit text' : 'Edit label');
      updateShape(editingTextId, { [target.field]: newText } as Partial<Shape>);
    }
    stopTextEdit();
  }, [editingTextId, shape, target, updateShape, stopTextEdit]);

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

  if (!canEdit || !shape || !target || !camera) {
    return null;
  }

  const isTextShape = isText(shape);
  const fontSize = target.fontSize * camera.zoom;

  // Text shapes anchor at their top-left with their own font; every other shape
  // centers the overlay on the target's world rect.
  const anchorWorld = isTextShape
    ? new Vec2(shape.x, shape.y)
    : new Vec2(target.worldRect.cx, target.worldRect.cy);
  const screenPos = camera.worldToScreen(anchorWorld);

  const editWidth = isTextShape ? shape.width : target.worldRect.width;
  const minWidth = Math.max(100, editWidth * camera.zoom);
  const minHeight = fontSize * 1.5;

  const offsetX = isTextShape ? 0 : -minWidth / 2;
  const offsetY = isTextShape ? 0 : -minHeight / 2;

  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${screenPos.x + offsetX}px`,
    top: `${screenPos.y + offsetY}px`,
    transform: `rotate(${target.rotation}rad)`,
    transformOrigin: isTextShape ? 'left top' : 'center center',
    fontSize: `${fontSize}px`,
    fontFamily: isTextShape ? shape.fontFamily : 'sans-serif',
    minWidth: `${minWidth}px`,
    minHeight: `${minHeight}px`,
    textAlign: target.align,
  };

  return (
    <div className="text-editor-overlay">
      <textarea
        ref={textareaRef}
        className="text-editor-textarea"
        style={style}
        defaultValue={readField(shape, target.field)}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        placeholder={isTextShape ? '' : 'Enter label...'}
      />
    </div>
  );
}

export default TextEditor;
