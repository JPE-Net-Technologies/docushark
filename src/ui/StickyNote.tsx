/**
 * StickyNote component for the whiteboard.
 *
 * Features:
 * - Draggable within whiteboard bounds
 * - Resizable via corner handle
 * - Customizable color via color picker with presets + recent colors
 * - contentEditable with formatting toolbar (bold, italic, underline)
 * - Keyboard shortcuts: Ctrl+B, Ctrl+I, Ctrl+U
 * - Delete button
 */

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useWhiteboardStore } from '../store/whiteboardStore';
import { useColorPaletteStore } from '../store/colorPaletteStore';
import { NOTE_PRESET_COLORS } from '../types/Whiteboard';
import { getContrastColor, darken } from '../utils/color';
import './StickyNote.css';

interface StickyNoteProps {
  id: string;
}

/**
 * Execute a formatting command and track active state.
 * Uses document.execCommand (still supported in all browsers).
 * TODO: Migrate to Selection/Range API for richer formatting (links, highlights).
 */
function execFormat(command: string): void {
  document.execCommand(command, false);
}

/**
 * Check if a formatting command is currently active in the selection.
 */
function isFormatActive(command: string): boolean {
  return document.queryCommandState(command);
}

export const StickyNote: React.FC<StickyNoteProps> = ({ id }) => {
  const note = useWhiteboardStore((state) => {
    const board = state.activeBoardId ? state.boards[state.activeBoardId] : undefined;
    return board?.notes[id];
  });
  const moveNote = useWhiteboardStore((state) => state.moveNote);
  const resizeNote = useWhiteboardStore((state) => state.resizeNote);
  const deleteNote = useWhiteboardStore((state) => state.deleteNote);
  const setNoteColor = useWhiteboardStore((state) => state.setNoteColor);
  const setNoteContent = useWhiteboardStore((state) => state.setNoteContent);
  const bringToFront = useWhiteboardStore((state) => state.bringToFront);
  const addRecentColor = useColorPaletteStore((state) => state.addRecentColor);
  const recentColors = useColorPaletteStore((state) => state.recentColors);

  const contentRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [formatState, setFormatState] = useState({ bold: false, italic: false, underline: false });
  const isInitialMount = useRef(true);

  // Set initial content only once on mount
  useEffect(() => {
    if (contentRef.current && isInitialMount.current && note) {
      isInitialMount.current = false;
      if (note.content && contentRef.current.innerHTML !== note.content) {
        contentRef.current.innerHTML = note.content;
      }
    }
  }, []);

  // Update formatting state when selection changes
  const updateFormatState = useCallback(() => {
    setFormatState({
      bold: isFormatActive('bold'),
      italic: isFormatActive('italic'),
      underline: isFormatActive('underline'),
    });
  }, []);

  // Track editing focus
  const handleContentFocus = useCallback(() => {
    setIsEditing(true);
    updateFormatState();
  }, [updateFormatState]);

  const handleContentBlur = useCallback(() => {
    setIsEditing(false);
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('.note-controls')) return;
      if ((e.target as HTMLElement).closest('.note-resize-handle')) return;
      if ((e.target as HTMLElement).closest('.note-color-picker')) return;
      if ((e.target as HTMLElement).closest('.note-content')) return;
      if ((e.target as HTMLElement).closest('.note-format-toolbar')) return;
      if (!note) return;

      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);
      setDragStart({ x: e.clientX - note.x, y: e.clientY - note.y });
      bringToFront(id);
    },
    [id, note, bringToFront]
  );

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsResizing(true);
      setDragStart({ x: e.clientX, y: e.clientY });
    },
    []
  );

  useEffect(() => {
    if (!note || (!isDragging && !isResizing)) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        const newX = e.clientX - dragStart.x;
        const newY = e.clientY - dragStart.y;
        moveNote(id, Math.max(0, newX), Math.max(0, newY));
      } else if (isResizing) {
        const deltaX = e.clientX - dragStart.x;
        const deltaY = e.clientY - dragStart.y;
        const newWidth = note.width + deltaX;
        const newHeight = note.height + deltaY;
        resizeNote(id, newWidth, newHeight);
        setDragStart({ x: e.clientX, y: e.clientY });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, isResizing, dragStart, id, note, moveNote, resizeNote]);

  const handleContentChange = useCallback(() => {
    if (contentRef.current) {
      const content = contentRef.current.innerHTML;
      setNoteContent(id, content);
    }
  }, [id, setNoteContent]);

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      deleteNote(id);
    },
    [id, deleteNote]
  );

  const handleColorChange = useCallback(
    (color: string) => {
      setNoteColor(id, color);
      addRecentColor(color);
      setShowColorPicker(false);
    },
    [id, setNoteColor, addRecentColor]
  );

  // Formatting toolbar button handler
  const handleFormat = useCallback(
    (command: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      contentRef.current?.focus();
      execFormat(command);
      updateFormatState();
      handleContentChange();
    },
    [updateFormatState, handleContentChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'b') {
          e.preventDefault();
          execFormat('bold');
          updateFormatState();
        } else if (e.key === 'i') {
          e.preventDefault();
          execFormat('italic');
          updateFormatState();
        } else if (e.key === 'u') {
          e.preventDefault();
          execFormat('underline');
          updateFormatState();
        }
      }
    },
    [updateFormatState]
  );

  if (!note) return null;

  const borderColor = darken(note.color, 15);
  const textColor = getContrastColor(note.color);
  const headerBg = darken(note.color, 8);

  const noteClasses = [
    'sticky-note',
    isDragging ? 'is-dragging' : '',
    isEditing ? 'is-editing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={noteClasses}
      style={{
        left: note.x,
        top: note.y,
        width: note.width,
        height: note.height,
        zIndex: note.zIndex,
        '--note-bg': note.color,
        '--note-border': borderColor,
        '--note-header-bg': headerBg,
        '--note-text': textColor,
      } as React.CSSProperties}
      onMouseDown={handleMouseDown}
    >
      {/* Header / drag handle */}
      <div
        className="note-header"
        onMouseDown={(e) => {
          e.stopPropagation();
          handleMouseDown(e);
        }}
      >
        <span className="note-header-label">Note</span>
        <div className="note-controls">
          {/* Color picker */}
          <div className="note-color-picker">
            <button
              className="note-color-btn"
              onClick={(e) => {
                e.stopPropagation();
                setShowColorPicker(!showColorPicker);
              }}
              style={{ backgroundColor: note.color }}
              title="Change color"
            />
            {showColorPicker && (
              <div className="note-color-dropdown">
                <div className="note-color-grid">
                  {NOTE_PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      className={`note-color-swatch ${c === note.color ? 'selected' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleColorChange(c);
                      }}
                      style={{ backgroundColor: c }}
                      title={c}
                    />
                  ))}
                </div>
                {recentColors.length > 0 && (
                  <>
                    <div className="note-color-section-label">Recent</div>
                    <div className="note-color-grid">
                      {recentColors.map((c) => (
                        <button
                          key={c}
                          className={`note-color-swatch ${c === note.color ? 'selected' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleColorChange(c);
                          }}
                          style={{ backgroundColor: c }}
                          title={c}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          {/* Delete button */}
          <button
            className="note-delete-btn"
            onClick={handleDelete}
            title="Delete note"
          >
            ×
          </button>
        </div>
      </div>

      {/* Formatting toolbar — visible when editing */}
      <div className="note-format-toolbar">
        <button
          className={`note-format-btn note-format-btn-bold ${formatState.bold ? 'active' : ''}`}
          onMouseDown={(e) => handleFormat('bold', e)}
          title="Bold (Ctrl+B)"
        >
          B
        </button>
        <button
          className={`note-format-btn note-format-btn-italic ${formatState.italic ? 'active' : ''}`}
          onMouseDown={(e) => handleFormat('italic', e)}
          title="Italic (Ctrl+I)"
        >
          I
        </button>
        <button
          className={`note-format-btn note-format-btn-underline ${formatState.underline ? 'active' : ''}`}
          onMouseDown={(e) => handleFormat('underline', e)}
          title="Underline (Ctrl+U)"
        >
          U
        </button>
      </div>

      {/* Content area */}
      <div
        ref={contentRef}
        className="note-content"
        contentEditable
        suppressContentEditableWarning
        onKeyDown={handleKeyDown}
        onKeyUp={updateFormatState}
        onMouseUp={updateFormatState}
        onInput={handleContentChange}
        onFocus={handleContentFocus}
        onBlur={handleContentBlur}
        onClick={(e) => e.stopPropagation()}
      />

      {/* Resize handle */}
      <div
        className="note-resize-handle"
        onMouseDown={handleResizeMouseDown}
      />
    </div>
  );
};
