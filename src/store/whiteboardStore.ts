/**
 * Whiteboard store for managing sticky notes across multiple boards.
 *
 * The whiteboard is a document-global overlay for idea tracking.
 * Notes are NOT canvas shapes - they're separate UI elements.
 * Supports multiple named boards, each with its own notes.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { nanoid } from 'nanoid';
import {
  WhiteboardNote,
  WhiteboardState,
  WhiteboardBoard,
  LegacyWhiteboardSnapshot,
  createEmptyWhiteboardState,
  createNote,
  createBoard,
  MIN_NOTE_WIDTH,
  MIN_NOTE_HEIGHT,
  DEFAULT_NOTE_COLOR,
} from '../types/Whiteboard';

/**
 * Helper to get the active board from state, or undefined.
 */
function getActiveBoard(state: WhiteboardState): WhiteboardBoard | undefined {
  if (!state.activeBoardId) return undefined;
  return state.boards[state.activeBoardId];
}

/**
 * Whiteboard store state and actions.
 */
export interface WhiteboardStore extends WhiteboardState {
  // Visibility
  toggleVisibility: () => void;
  setVisibility: (isVisible: boolean) => void;

  // Board CRUD
  addBoard: (name?: string) => string;
  deleteBoard: (id: string) => void;
  renameBoard: (id: string, name: string) => void;
  duplicateBoard: (id: string) => string | null;
  setActiveBoard: (id: string) => void;
  reorderBoards: (newOrder: string[]) => void;

  // Note CRUD (operates on active board)
  addNote: (x: number, y: number, color?: string) => string;
  updateNote: (id: string, updates: Partial<WhiteboardNote>) => void;
  deleteNote: (id: string) => void;

  // Position and size
  moveNote: (id: string, x: number, y: number) => void;
  resizeNote: (id: string, width: number, height: number) => void;

  // Z-order
  bringToFront: (id: string) => void;
  sendToBack: (id: string) => void;

  // Content
  setNoteContent: (id: string, content: string) => void;
  setNoteColor: (id: string, color: string) => void;

  // Bulk operations
  clear: () => void;

  // Persistence
  getSnapshot: () => WhiteboardState;
  loadSnapshot: (snapshot: WhiteboardState | LegacyWhiteboardSnapshot) => void;
  reset: () => void;
}

const initialState: WhiteboardState = createEmptyWhiteboardState();

export const useWhiteboardStore = create<WhiteboardStore>()(
  immer((set, get) => ({
    ...initialState,

    toggleVisibility: () => {
      set((state) => {
        state.isVisible = !state.isVisible;
      });
    },

    setVisibility: (isVisible: boolean) => {
      set((state) => {
        state.isVisible = isVisible;
      });
    },

    // ── Board CRUD ───────────────────────────────────────

    addBoard: (name?: string): string => {
      const id = nanoid();
      set((state) => {
        const boardName = name ?? `Board ${state.boardOrder.length + 1}`;
        const board = createBoard(id, boardName);
        state.boards[id] = board;
        state.boardOrder.push(id);
        state.activeBoardId = id;
      });
      return id;
    },

    deleteBoard: (id: string) => {
      set((state) => {
        if (state.boardOrder.length <= 1) return;
        const index = state.boardOrder.indexOf(id);
        if (index === -1) return;

        delete state.boards[id];
        state.boardOrder.splice(index, 1);

        if (state.activeBoardId === id) {
          const newIndex = Math.min(index, state.boardOrder.length - 1);
          state.activeBoardId = state.boardOrder[newIndex] ?? state.boardOrder[0] ?? null;
        }
      });
    },

    renameBoard: (id: string, name: string) => {
      set((state) => {
        const board = state.boards[id];
        if (board) {
          board.name = name;
        }
      });
    },

    duplicateBoard: (id: string): string | null => {
      const sourceBoard = get().boards[id];
      if (!sourceBoard) return null;

      const newId = nanoid();
      set((state) => {
        const newBoard: WhiteboardBoard = {
          ...JSON.parse(JSON.stringify(sourceBoard)),
          id: newId,
          name: `${sourceBoard.name} (copy)`,
          createdAt: Date.now(),
        };
        state.boards[newId] = newBoard;
        const sourceIndex = state.boardOrder.indexOf(id);
        if (sourceIndex !== -1) {
          state.boardOrder.splice(sourceIndex + 1, 0, newId);
        } else {
          state.boardOrder.push(newId);
        }
        state.activeBoardId = newId;
      });
      return newId;
    },

    setActiveBoard: (id: string) => {
      set((state) => {
        if (state.boards[id]) {
          state.activeBoardId = id;
        }
      });
    },

    reorderBoards: (newOrder: string[]) => {
      set((state) => {
        state.boardOrder = newOrder;
      });
    },

    // ── Note CRUD (operates on active board) ─────────────

    addNote: (x: number, y: number, color: string = DEFAULT_NOTE_COLOR): string => {
      const id = nanoid();
      set((state) => {
        const board = getActiveBoard(state);
        if (!board) return;

        const note = createNote(id, x, y, color);
        note.zIndex = board.noteOrder.length + 1;
        board.notes[id] = note;
        board.noteOrder.push(id);
      });
      return id;
    },

    updateNote: (id: string, updates: Partial<WhiteboardNote>) => {
      set((state) => {
        const board = getActiveBoard(state);
        if (!board) return;
        const note = board.notes[id];
        if (note) {
          Object.assign(note, updates, { modifiedAt: Date.now() });
        }
      });
    },

    deleteNote: (id: string) => {
      set((state) => {
        const board = getActiveBoard(state);
        if (!board) return;
        delete board.notes[id];
        board.noteOrder = board.noteOrder.filter((noteId) => noteId !== id);
      });
    },

    moveNote: (id: string, x: number, y: number) => {
      set((state) => {
        const board = getActiveBoard(state);
        if (!board) return;
        const note = board.notes[id];
        if (note) {
          note.x = x;
          note.y = y;
          note.modifiedAt = Date.now();
        }
      });
    },

    resizeNote: (id: string, width: number, height: number) => {
      set((state) => {
        const board = getActiveBoard(state);
        if (!board) return;
        const note = board.notes[id];
        if (note) {
          note.width = Math.max(width, MIN_NOTE_WIDTH);
          note.height = Math.max(height, MIN_NOTE_HEIGHT);
          note.modifiedAt = Date.now();
        }
      });
    },

    bringToFront: (id: string) => {
      set((state) => {
        const board = getActiveBoard(state);
        if (!board) return;
        const index = board.noteOrder.indexOf(id);
        if (index === -1 || index === board.noteOrder.length - 1) return;

        board.noteOrder.splice(index, 1);
        board.noteOrder.push(id);

        const maxZ = board.noteOrder.length;
        if (board.notes[id]) {
          board.notes[id].zIndex = maxZ;
        }
      });
    },

    sendToBack: (id: string) => {
      set((state) => {
        const board = getActiveBoard(state);
        if (!board) return;
        const index = board.noteOrder.indexOf(id);
        if (index === -1 || index === 0) return;

        board.noteOrder.splice(index, 1);
        board.noteOrder.unshift(id);

        if (board.notes[id]) {
          board.notes[id].zIndex = 1;
        }
      });
    },

    setNoteContent: (id: string, content: string) => {
      set((state) => {
        const board = getActiveBoard(state);
        if (!board) return;
        const note = board.notes[id];
        if (note) {
          note.content = content;
          note.modifiedAt = Date.now();
        }
      });
    },

    setNoteColor: (id: string, color: string) => {
      set((state) => {
        const board = getActiveBoard(state);
        if (!board) return;
        const note = board.notes[id];
        if (note) {
          note.color = color;
          note.modifiedAt = Date.now();
        }
      });
    },

    clear: () => {
      set((state) => {
        const board = getActiveBoard(state);
        if (!board) return;
        board.notes = {};
        board.noteOrder = [];
      });
    },

    getSnapshot: (): WhiteboardState => {
      const state = get();
      return {
        boards: JSON.parse(JSON.stringify(state.boards)),
        boardOrder: [...state.boardOrder],
        activeBoardId: state.activeBoardId,
        isVisible: state.isVisible,
      };
    },

    loadSnapshot: (snapshot: WhiteboardState | LegacyWhiteboardSnapshot) => {
      set((state) => {
        // Detect legacy single-board format (has root `notes`, no `boards`)
        const legacy = snapshot as LegacyWhiteboardSnapshot;
        const modern = snapshot as WhiteboardState;

        if (modern.boards && modern.boardOrder) {
          // Modern multi-board format
          state.boards = modern.boards;
          state.boardOrder = modern.boardOrder;
          state.activeBoardId = modern.activeBoardId ?? modern.boardOrder[0] ?? null;
          state.isVisible = modern.isVisible ?? false;
        } else if (legacy.notes !== undefined || legacy.noteOrder !== undefined) {
          // Legacy single-board format — migrate to a single board
          const boardId = 'migrated-board';
          const board = createBoard(boardId, 'Board 1');
          board.notes = legacy.notes ?? {};
          board.noteOrder = legacy.noteOrder ?? [];
          state.boards = { [boardId]: board };
          state.boardOrder = [boardId];
          state.activeBoardId = boardId;
          state.isVisible = legacy.isVisible ?? false;
        } else {
          // Empty/unknown — reset to defaults
          const defaults = createEmptyWhiteboardState();
          state.boards = defaults.boards;
          state.boardOrder = defaults.boardOrder;
          state.activeBoardId = defaults.activeBoardId;
          state.isVisible = false;
        }
      });
    },

    reset: () => {
      set(() => ({ ...createEmptyWhiteboardState() }));
    },
  }))
);
