import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import './ReorderableList.css';

/**
 * Props spread onto a row's drag handle element. The handle starts a pointer
 * drag and also supports keyboard reordering (Arrow Up/Down).
 */
export interface ReorderHandleProps {
  onPointerDown: (e: React.PointerEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  role: 'button';
  tabIndex: 0;
  'aria-label': string;
  style: React.CSSProperties;
}

interface ReorderableListProps<T> {
  items: T[];
  /** Stable-ish key per item. Defaults to the index. */
  getKey?: (item: T, index: number) => string | number;
  /** Commit a reorder: move the item at `fromIndex` to `toIndex`. */
  onReorder: (fromIndex: number, toIndex: number) => void;
  /** Render a row's inner content; spread `handleProps` onto the drag handle. */
  renderItem: (item: T, index: number, handleProps: ReorderHandleProps) => ReactNode;
  /** Class on the list container (keeps existing layout CSS, e.g. gap). */
  listClassName?: string;
  /** Class on each row wrapper (e.g. 'erd-member-row'); 'dragging'/'drag-over' are appended. */
  rowClassName?: string;
}

/**
 * A small, dependency-free reorderable list driven by **pointer events**.
 *
 * Replaces the native HTML5 drag-and-drop API, which is unreliable across the
 * web/Tauri matrix and frequently doesn't fire at all in WebKitGTK (the Linux
 * webview Tauri uses) — the root cause of JP-30, where panel list items
 * "don't move at all". Pointer events work everywhere.
 *
 * The dragged row follows the pointer (transform), the target gap shows a drop
 * line, and the handle supports keyboard reordering for accessibility.
 */
export function ReorderableList<T>({
  items,
  getKey,
  onReorder,
  renderItem,
  listClassName,
  rowClassName,
}: ReorderableListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [dragY, setDragY] = useState(0);

  // Mirrors for use inside window listeners (which capture stale state).
  const rectsRef = useRef<DOMRect[]>([]);
  const startYRef = useRef(0);
  const dragIndexRef = useRef<number | null>(null);
  const overIndexRef = useRef<number | null>(null);
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const setDrag = (v: number | null) => {
    dragIndexRef.current = v;
    setDragIndex(v);
  };
  const setOver = (v: number | null) => {
    overIndexRef.current = v;
    setOverIndex(v);
  };

  const startDrag = useCallback((e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    // Cache row rects once, at drag start, so pointermove doesn't thrash layout.
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-reorder-index]'));
    rectsRef.current = rows.map((r) => r.getBoundingClientRect());
    startYRef.current = e.clientY;
    setDragY(0);
    setDrag(index);
    setOver(index);
  }, []);

  useEffect(() => {
    if (dragIndex === null) return;

    // The row whose vertical span contains the pointer (clamped to the ends).
    const computeOver = (y: number): number => {
      const rects = rectsRef.current;
      if (rects.length === 0) return dragIndexRef.current ?? 0;
      if (y < rects[0]!.top) return 0;
      for (let i = 0; i < rects.length; i++) {
        if (y <= rects[i]!.bottom) return i;
      }
      return rects.length - 1;
    };

    const handleMove = (e: PointerEvent) => {
      setDragY(e.clientY - startYRef.current);
      setOver(computeOver(e.clientY));
    };
    const handleUp = () => {
      const from = dragIndexRef.current;
      const to = overIndexRef.current;
      if (from !== null && to !== null && from !== to) onReorderRef.current(from, to);
      setDrag(null);
      setOver(null);
      setDragY(0);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [dragIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      if (e.key === 'ArrowUp' && index > 0) {
        e.preventDefault();
        onReorderRef.current(index, index - 1);
      } else if (e.key === 'ArrowDown' && index < items.length - 1) {
        e.preventDefault();
        onReorderRef.current(index, index + 1);
      }
    },
    [items.length]
  );

  const makeHandleProps = (index: number): ReorderHandleProps => ({
    onPointerDown: (e) => startDrag(e, index),
    onKeyDown: (e) => handleKeyDown(e, index),
    role: 'button',
    tabIndex: 0,
    'aria-label': 'Drag to reorder',
    style: { cursor: dragIndex === null ? 'grab' : 'grabbing', touchAction: 'none' },
  });

  return (
    <div className={`reorderable-list ${listClassName ?? ''}`} ref={containerRef}>
      {items.map((item, index) => {
        const isDragging = dragIndex === index;
        const isTarget = dragIndex !== null && overIndex === index && !isDragging;
        const rowStyle: React.CSSProperties = isDragging
          ? { transform: `translateY(${dragY}px)`, zIndex: 2, position: 'relative' }
          : {};
        return (
          <div
            key={getKey ? getKey(item, index) : index}
            data-reorder-index={index}
            style={rowStyle}
            className={
              `${rowClassName ?? ''} reorderable-row` +
              (isDragging ? ' dragging' : '') +
              (isTarget ? ' drag-over' : '')
            }
          >
            {renderItem(item, index, makeHandleProps(index))}
          </div>
        );
      })}
    </div>
  );
}

export default ReorderableList;
