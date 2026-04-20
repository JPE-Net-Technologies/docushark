/**
 * Whiteboard overlay component.
 *
 * Full-viewport overlay for sticky notes, accessible via Ctrl+I.
 * Supports multiple named boards with tab-based navigation.
 */

import React, { useCallback, useEffect, useState, useRef, useLayoutEffect } from 'react';
import { useWhiteboardStore } from '../store/whiteboardStore';
import { StickyNote } from './StickyNote';
import { clampToViewport } from './contextMenuUtils';
import './Whiteboard.css';

/**
 * Context menu state for board tabs.
 */
interface BoardContextMenu {
  visible: boolean;
  x: number;
  y: number;
  boardId: string;
}

export const Whiteboard: React.FC = () => {
  const isVisible = useWhiteboardStore((state) => state.isVisible);
  const setVisibility = useWhiteboardStore((state) => state.setVisibility);
  const addNote = useWhiteboardStore((state) => state.addNote);

  // Board state
  const boards = useWhiteboardStore((state) => state.boards);
  const boardOrder = useWhiteboardStore((state) => state.boardOrder);
  const activeBoardId = useWhiteboardStore((state) => state.activeBoardId);
  const addBoard = useWhiteboardStore((state) => state.addBoard);
  const deleteBoard = useWhiteboardStore((state) => state.deleteBoard);
  const renameBoard = useWhiteboardStore((state) => state.renameBoard);
  const duplicateBoard = useWhiteboardStore((state) => state.duplicateBoard);
  const setActiveBoard = useWhiteboardStore((state) => state.setActiveBoard);

  // Active board's note order
  const noteOrder = useWhiteboardStore((state) => {
    const board = state.activeBoardId ? state.boards[state.activeBoardId] : undefined;
    return board?.noteOrder ?? [];
  });

  const noteCount = noteOrder.length;

  // Board tab editing
  const [editingBoardId, setEditingBoardId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // Board tab context menu
  const [contextMenu, setContextMenu] = useState<BoardContextMenu>({
    visible: false,
    x: 0,
    y: 0,
    boardId: '',
  });
  const [adjustedPos, setAdjustedPos] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => {
    setVisibility(false);
  }, [setVisibility]);

  const handleAddNote = useCallback(() => {
    const x = 100 + Math.random() * 200;
    const y = 100 + Math.random() * 200;
    addNote(x, y);
  }, [addNote]);

  // Double-click on board background to add note at position
  const handleBoardDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('.sticky-note')) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      addNote(x, y);
    },
    [addNote]
  );

  // Escape to close
  useEffect(() => {
    if (!isVisible) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isVisible, handleClose]);

  // Board tab actions
  const handleTabClick = useCallback(
    (boardId: string) => {
      if (editingBoardId) return;
      setActiveBoard(boardId);
    },
    [setActiveBoard, editingBoardId]
  );

  const handleTabDoubleClick = useCallback((boardId: string, currentName: string) => {
    setEditingBoardId(boardId);
    setEditValue(currentName);
  }, []);

  const handleEditSubmit = useCallback(() => {
    if (editingBoardId && editValue.trim()) {
      renameBoard(editingBoardId, editValue.trim());
    }
    setEditingBoardId(null);
    setEditValue('');
  }, [editingBoardId, editValue, renameBoard]);

  const handleEditCancel = useCallback(() => {
    setEditingBoardId(null);
    setEditValue('');
  }, []);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleEditSubmit();
      } else if (e.key === 'Escape') {
        handleEditCancel();
      }
    },
    [handleEditSubmit, handleEditCancel]
  );

  useEffect(() => {
    if (editingBoardId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingBoardId]);

  // Context menu
  const handleContextMenu = useCallback((e: React.MouseEvent, boardId: string) => {
    e.preventDefault();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, boardId });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  useEffect(() => {
    if (!contextMenu.visible) {
      setAdjustedPos(null);
      return;
    }
    const handleClick = () => closeContextMenu();
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [contextMenu.visible, closeContextMenu]);

  useLayoutEffect(() => {
    if (!contextMenu.visible || !contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    setAdjustedPos(clampToViewport(contextMenu.x, contextMenu.y, rect.width, rect.height));
  }, [contextMenu.visible, contextMenu.x, contextMenu.y]);

  const handleContextRename = useCallback(() => {
    const board = boards[contextMenu.boardId];
    if (board) {
      setEditingBoardId(contextMenu.boardId);
      setEditValue(board.name);
    }
    closeContextMenu();
  }, [contextMenu.boardId, boards, closeContextMenu]);

  const handleContextDuplicate = useCallback(() => {
    duplicateBoard(contextMenu.boardId);
    closeContextMenu();
  }, [contextMenu.boardId, duplicateBoard, closeContextMenu]);

  const handleContextDelete = useCallback(() => {
    if (boardOrder.length > 1) {
      deleteBoard(contextMenu.boardId);
    }
    closeContextMenu();
  }, [contextMenu.boardId, boardOrder.length, deleteBoard, closeContextMenu]);

  const handleAddBoard = useCallback(() => {
    addBoard();
  }, [addBoard]);

  if (!isVisible) return null;

  const activeBoard = activeBoardId ? boards[activeBoardId] : undefined;

  return (
    <div className="whiteboard-overlay" onClick={handleClose}>
      <div className="whiteboard-backdrop" />
      <div className="whiteboard-container" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="whiteboard-header">
          <div className="whiteboard-header-left">
            <h2 className="whiteboard-title">Whiteboard</h2>
            {activeBoard && (
              <span className="whiteboard-note-count">
                {noteCount} {noteCount === 1 ? 'note' : 'notes'}
              </span>
            )}
          </div>
          <button
            className="whiteboard-close-btn"
            onClick={handleClose}
            title="Close (Esc)"
          >
            ×
          </button>
        </div>

        {/* Board tabs */}
        <div className="whiteboard-board-tabs">
          <div className="whiteboard-board-tabs-list">
            {boardOrder.map((boardId) => {
              const board = boards[boardId];
              if (!board) return null;

              const isActive = boardId === activeBoardId;
              const isEditing = boardId === editingBoardId;

              return (
                <div
                  key={boardId}
                  className={`whiteboard-board-tab ${isActive ? 'active' : ''}`}
                  onClick={() => handleTabClick(boardId)}
                  onDoubleClick={() => handleTabDoubleClick(boardId, board.name)}
                  onContextMenu={(e) => handleContextMenu(e, boardId)}
                >
                  {isEditing ? (
                    <input
                      ref={editInputRef}
                      type="text"
                      className="whiteboard-board-tab-input"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={handleEditSubmit}
                      onKeyDown={handleEditKeyDown}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="whiteboard-board-tab-name">{board.name}</span>
                  )}
                </div>
              );
            })}
          </div>
          <button
            className="whiteboard-board-tab-add"
            onClick={handleAddBoard}
            title="Add new board"
          >
            +
          </button>
        </div>

        {/* Notes area */}
        <div
          className="whiteboard-notes"
          onDoubleClick={handleBoardDoubleClick}
        >
          {noteOrder.length === 0 && (
            <div className="whiteboard-empty-state">
              <div className="whiteboard-empty-icon">📝</div>
              <div className="whiteboard-empty-text">
                Click <strong>+</strong> or double-click to add a note
              </div>
            </div>
          )}
          {noteOrder.map((noteId) => (
            <StickyNote key={noteId} id={noteId} />
          ))}
        </div>

        {/* Add Note button */}
        <button className="whiteboard-add-btn" onClick={handleAddNote} title="Add note">
          +
        </button>

        {/* Board tab context menu */}
        {contextMenu.visible && (() => {
          const menuPos = adjustedPos ?? { x: contextMenu.x, y: contextMenu.y };
          return (
            <div
              ref={contextMenuRef}
              className="whiteboard-board-context-menu"
              style={{ left: menuPos.x, top: menuPos.y }}
            >
              <button onClick={handleContextRename}>Rename</button>
              <button onClick={handleContextDuplicate}>Duplicate</button>
              <button
                onClick={handleContextDelete}
                disabled={boardOrder.length <= 1}
                className={boardOrder.length <= 1 ? 'disabled' : ''}
              >
                Delete
              </button>
            </div>
          );
        })()}
      </div>
    </div>
  );
};
