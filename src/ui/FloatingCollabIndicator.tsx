/**
 * Floating, draggable collaboration indicator (JP-315).
 *
 * Wraps {@link PresenceIndicators} in a movable pill that the user can drag
 * anywhere on screen; its position persists app-wide via `uiPreferencesStore`.
 * It mounts **only when at least one remote collaborator is present** — when
 * you are alone it shows nothing (the old fixed overlay showed a bare dot).
 *
 * Dragging uses pointer events (not HTML5 DnD, which is dead in WebKitGTK — see
 * ReorderableList.tsx / JP-30). The floating form is also the seam for future
 * in-document communications.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import { useCollaborationStore } from '../collaboration';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';
import { PresenceIndicators } from './PresenceIndicators';
import {
  clampToViewport,
  resolveIndicatorPosition,
  type Point,
  type Size,
} from './floatingPosition';
import './FloatingCollabIndicator.css';

/** Pixels nudged per arrow-key press on the focused grip (a11y). */
const KEY_NUDGE = 12;

function readViewport(): Size {
  return { w: window.innerWidth, h: window.innerHeight };
}

export function FloatingCollabIndicator() {
  const isActive = useCollaborationStore((s) => s.isActive);
  const remoteUsers = useCollaborationStore((s) => s.remoteUsers);
  const stored = useUIPreferencesStore((s) => s.collabIndicatorPos);
  const setStored = useUIPreferencesStore((s) => s.setCollabIndicatorPos);

  const containerRef = useRef<HTMLDivElement>(null);

  // Viewport tracked in state so a resize re-clamps the rendered position. This
  // only re-renders; it never writes to the store (which would thrash
  // localStorage) — the store is committed solely on drag-end / key-nudge.
  const [viewport, setViewport] = useState<Size>(() => readViewport());
  // Measured pill size; seeded with an estimate, corrected after layout.
  const [size, setSize] = useState<Size>({ w: 160, h: 40 });
  // Transient top-left while dragging (null = not dragging, use resolved).
  const [dragPos, setDragPos] = useState<Point | null>(null);

  // Mirrors for window listeners, which would otherwise capture stale state.
  const pointerOffsetRef = useRef<Point>({ x: 0, y: 0 });
  const sizeRef = useRef<Size>(size);
  sizeRef.current = size;
  const dragPosRef = useRef<Point | null>(null);

  // Keep the rendered size in sync (the pill widens as collaborators join).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width && rect.height) {
      setSize((prev) =>
        prev.w === rect.width && prev.h === rect.height
          ? prev
          : { w: rect.width, h: rect.height }
      );
    }
  }, [remoteUsers.length, isActive]);

  // Re-clamp on viewport resize (render-only; no persistence).
  useEffect(() => {
    const onResize = () => setViewport(readViewport());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const resolved = resolveIndicatorPosition(stored, size, viewport);
  const rendered = dragPos ?? resolved;

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      const topLeft = rect ? { x: rect.left, y: rect.top } : rendered;
      pointerOffsetRef.current = { x: e.clientX - topLeft.x, y: e.clientY - topLeft.y };
      dragPosRef.current = topLeft;
      setDragPos(topLeft);
    },
    [rendered]
  );

  // Window-level drag listeners — survive the pointer leaving the small grip.
  useEffect(() => {
    if (dragPos === null) return;

    const handleMove = (e: PointerEvent) => {
      const next = clampToViewport(
        {
          x: e.clientX - pointerOffsetRef.current.x,
          y: e.clientY - pointerOffsetRef.current.y,
        },
        sizeRef.current,
        readViewport()
      );
      dragPosRef.current = next;
      setDragPos(next);
    };
    const handleUp = () => {
      const committed = dragPosRef.current;
      if (committed) setStored(committed);
      dragPosRef.current = null;
      setDragPos(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [dragPos, setStored]);

  const onGripKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const delta: Point = { x: 0, y: 0 };
      if (e.key === 'ArrowLeft') delta.x = -KEY_NUDGE;
      else if (e.key === 'ArrowRight') delta.x = KEY_NUDGE;
      else if (e.key === 'ArrowUp') delta.y = -KEY_NUDGE;
      else if (e.key === 'ArrowDown') delta.y = KEY_NUDGE;
      else return;
      e.preventDefault();
      setStored(
        clampToViewport(
          { x: resolved.x + delta.x, y: resolved.y + delta.y },
          sizeRef.current,
          readViewport()
        )
      );
    },
    [resolved, setStored]
  );

  // Hide-when-alone gate — placed AFTER all hooks (rules of hooks). With no
  // remote users present, render nothing.
  if (!isActive || remoteUsers.length === 0) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className={`floating-collab${dragPos ? ' floating-collab--dragging' : ''}`}
      style={{ left: rendered.x, top: rendered.y }}
    >
      <span
        className="floating-collab-grip"
        role="button"
        tabIndex={0}
        aria-label="Move collaboration indicator"
        onPointerDown={startDrag}
        onKeyDown={onGripKeyDown}
      >
        <GripVertical size={14} strokeWidth={1.5} aria-hidden />
      </span>
      <PresenceIndicators size="small" />
    </div>
  );
}

export default FloatingCollabIndicator;
