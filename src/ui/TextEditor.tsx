import { useDocumentStore } from '../store/documentStore';
import { isText } from '../shapes/Shape';
import { Vec2 } from '../math/Vec2';
import { Camera } from '../engine/Camera';
import { useInlineLabelEditor, getEditTarget, readField } from './useInlineLabelEditor';
import './TextEditor.css';

export interface TextEditorProps {
  camera: Camera | null;
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
 * The *edit session* (the in-progress draft, focus, save-on-blur/Enter) is owned
 * by {@link useInlineLabelEditor}, which seeds the textarea exactly once per
 * session. This component is responsible only for *positioning* the overlay,
 * which intentionally stays reactive so the box follows the shape as it moves.
 * Keeping those two concerns apart is what stops unrelated re-renders (autosave
 * status pulses, cache writes, CRDT sync) from wiping a draft mid-type.
 */
export function TextEditor({ camera }: TextEditorProps) {
  const { editingTextId, textareaRef, handleSave, handleKeyDown } =
    useInlineLabelEditor();
  // Subscribed for positioning only — the draft value is owned by the hook.
  const shapes = useDocumentStore((state) => state.shapes);

  const shape = editingTextId ? shapes[editingTextId] : null;
  const target = getEditTarget(shape);
  const canEdit = !!shape && target !== null;

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
