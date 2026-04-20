/**
 * Tests for the whiteboard store (multi-board architecture).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useWhiteboardStore } from './whiteboardStore';
import {
  createEmptyWhiteboardState,
  createNote,
  DEFAULT_NOTE_WIDTH,
  DEFAULT_NOTE_HEIGHT,
  MIN_NOTE_WIDTH,
  MIN_NOTE_HEIGHT,
  DEFAULT_NOTE_COLOR,
} from '../types/Whiteboard';

/** Helper: get notes from the active board. */
function getActiveNotes() {
  const state = useWhiteboardStore.getState();
  const board = state.activeBoardId ? state.boards[state.activeBoardId] : undefined;
  return board?.notes ?? {};
}

/** Helper: get noteOrder from the active board. */
function getActiveNoteOrder() {
  const state = useWhiteboardStore.getState();
  const board = state.activeBoardId ? state.boards[state.activeBoardId] : undefined;
  return board?.noteOrder ?? [];
}

describe('WhiteboardStore', () => {
  beforeEach(() => {
    useWhiteboardStore.getState().reset();
  });

  describe('visibility', () => {
    it('starts hidden', () => {
      expect(useWhiteboardStore.getState().isVisible).toBe(false);
    });

    it('toggles visibility', () => {
      const store = useWhiteboardStore.getState();
      store.toggleVisibility();
      expect(useWhiteboardStore.getState().isVisible).toBe(true);

      store.toggleVisibility();
      expect(useWhiteboardStore.getState().isVisible).toBe(false);
    });

    it('sets visibility explicitly', () => {
      const store = useWhiteboardStore.getState();
      store.setVisibility(true);
      expect(useWhiteboardStore.getState().isVisible).toBe(true);

      store.setVisibility(false);
      expect(useWhiteboardStore.getState().isVisible).toBe(false);
    });
  });

  describe('board management', () => {
    it('starts with one default board', () => {
      const state = useWhiteboardStore.getState();
      expect(state.boardOrder.length).toBe(1);
      expect(state.activeBoardId).toBe(state.boardOrder[0]);
      const board = state.boards[state.boardOrder[0]!];
      expect(board).toBeDefined();
      expect(board!.name).toBe('Board 1');
    });

    it('adds a new board', () => {
      const store = useWhiteboardStore.getState();
      const newId = store.addBoard('My Board');

      const state = useWhiteboardStore.getState();
      expect(state.boardOrder.length).toBe(2);
      expect(state.boards[newId]).toBeDefined();
      expect(state.boards[newId]!.name).toBe('My Board');
      // Active board switches to the new one
      expect(state.activeBoardId).toBe(newId);
    });

    it('renames a board', () => {
      const state = useWhiteboardStore.getState();
      const boardId = state.boardOrder[0]!;
      state.renameBoard(boardId, 'Renamed');

      const updated = useWhiteboardStore.getState();
      expect(updated.boards[boardId]!.name).toBe('Renamed');
    });

    it('deletes a board (not the last one)', () => {
      const store = useWhiteboardStore.getState();
      const originalId = store.boardOrder[0]!;
      const newId = store.addBoard('Second');

      store.deleteBoard(originalId);

      const state = useWhiteboardStore.getState();
      expect(state.boardOrder).not.toContain(originalId);
      expect(state.boards[originalId]).toBeUndefined();
      expect(state.activeBoardId).toBe(newId);
    });

    it('does not delete the last board', () => {
      const store = useWhiteboardStore.getState();
      const boardId = store.boardOrder[0]!;

      store.deleteBoard(boardId);

      const state = useWhiteboardStore.getState();
      expect(state.boardOrder.length).toBe(1);
      expect(state.boards[boardId]).toBeDefined();
    });

    it('duplicates a board with its notes', () => {
      const store = useWhiteboardStore.getState();
      const boardId = store.boardOrder[0]!;
      store.addNote(10, 20);
      store.addNote(30, 40);

      const dupId = store.duplicateBoard(boardId);
      expect(dupId).not.toBeNull();

      const state = useWhiteboardStore.getState();
      const original = state.boards[boardId]!;
      const duplicate = state.boards[dupId!]!;

      expect(duplicate.name).toContain('copy');
      expect(Object.keys(duplicate.notes).length).toBe(Object.keys(original.notes).length);
      expect(duplicate.noteOrder.length).toBe(original.noteOrder.length);
    });

    it('switches active board', () => {
      const store = useWhiteboardStore.getState();
      const firstId = store.boardOrder[0]!;
      const secondId = store.addBoard('Second');

      store.setActiveBoard(firstId);
      expect(useWhiteboardStore.getState().activeBoardId).toBe(firstId);

      store.setActiveBoard(secondId);
      expect(useWhiteboardStore.getState().activeBoardId).toBe(secondId);
    });

    it('reorders boards', () => {
      const store = useWhiteboardStore.getState();
      const firstId = store.boardOrder[0]!;
      const secondId = store.addBoard('Second');
      const thirdId = store.addBoard('Third');

      store.reorderBoards([thirdId, firstId, secondId]);
      expect(useWhiteboardStore.getState().boardOrder).toEqual([thirdId, firstId, secondId]);
    });
  });

  describe('note CRUD (active board)', () => {
    it('adds a note to the active board', () => {
      const store = useWhiteboardStore.getState();
      const noteId = store.addNote(100, 200);

      const notes = getActiveNotes();
      expect(notes[noteId]).toBeDefined();
      expect(notes[noteId]!.x).toBe(100);
      expect(notes[noteId]!.y).toBe(200);
      expect(notes[noteId]!.color).toBe(DEFAULT_NOTE_COLOR);
      expect(getActiveNoteOrder()).toContain(noteId);
    });

    it('adds a note with custom color', () => {
      const store = useWhiteboardStore.getState();
      const noteId = store.addNote(0, 0, '#3b82f6');
      expect(getActiveNotes()[noteId]!.color).toBe('#3b82f6');
    });

    it('updates a note', () => {
      const noteId = useWhiteboardStore.getState().addNote(0, 0);
      const originalModifiedAt = getActiveNotes()[noteId]!.modifiedAt;

      useWhiteboardStore.getState().updateNote(noteId, { content: 'Updated content' });

      const notes = getActiveNotes();
      expect(notes[noteId]!.content).toBe('Updated content');
      expect(notes[noteId]!.modifiedAt).toBeGreaterThanOrEqual(originalModifiedAt);
    });

    it('deletes a note', () => {
      const store = useWhiteboardStore.getState();
      const noteId = store.addNote(0, 0);

      store.deleteNote(noteId);

      expect(getActiveNotes()[noteId]).toBeUndefined();
      expect(getActiveNoteOrder()).not.toContain(noteId);
    });

    it('moves a note', () => {
      const store = useWhiteboardStore.getState();
      const noteId = store.addNote(0, 0);

      store.moveNote(noteId, 150, 250);

      const notes = getActiveNotes();
      expect(notes[noteId]!.x).toBe(150);
      expect(notes[noteId]!.y).toBe(250);
    });

    it('resizes a note with minimum constraints', () => {
      const store = useWhiteboardStore.getState();
      const noteId = store.addNote(0, 0);

      store.resizeNote(noteId, 50, 40);

      const notes = getActiveNotes();
      expect(notes[noteId]!.width).toBe(MIN_NOTE_WIDTH);
      expect(notes[noteId]!.height).toBe(MIN_NOTE_HEIGHT);
    });

    it('resizes a note above minimum', () => {
      const store = useWhiteboardStore.getState();
      const noteId = store.addNote(0, 0);

      store.resizeNote(noteId, 300, 250);

      const notes = getActiveNotes();
      expect(notes[noteId]!.width).toBe(300);
      expect(notes[noteId]!.height).toBe(250);
    });
  });

  describe('z-order', () => {
    it('brings note to front', () => {
      const store = useWhiteboardStore.getState();
      const id1 = store.addNote(0, 0);
      const id2 = store.addNote(0, 0);
      const id3 = store.addNote(0, 0);

      expect(getActiveNoteOrder()).toEqual([id1, id2, id3]);

      store.bringToFront(id1);

      expect(getActiveNoteOrder()).toEqual([id2, id3, id1]);
    });

    it('sends note to back', () => {
      const store = useWhiteboardStore.getState();
      const id1 = store.addNote(0, 0);
      const id2 = store.addNote(0, 0);
      const id3 = store.addNote(0, 0);

      expect(getActiveNoteOrder()).toEqual([id1, id2, id3]);

      store.sendToBack(id3);

      expect(getActiveNoteOrder()).toEqual([id3, id1, id2]);
    });
  });

  describe('note content and color', () => {
    it('sets note content', () => {
      const store = useWhiteboardStore.getState();
      const noteId = store.addNote(0, 0);

      store.setNoteContent(noteId, 'Hello <b>World</b>');

      expect(getActiveNotes()[noteId]!.content).toBe('Hello <b>World</b>');
    });

    it('sets note color', () => {
      const store = useWhiteboardStore.getState();
      const noteId = store.addNote(0, 0);

      store.setNoteColor(noteId, 'pink');

      expect(getActiveNotes()[noteId]!.color).toBe('pink');
    });
  });

  describe('notes are board-scoped', () => {
    it('notes stay on their board when switching', () => {
      const store = useWhiteboardStore.getState();
      const board1Id = store.boardOrder[0]!;
      const noteOnBoard1 = store.addNote(10, 20);

      store.addBoard('Board 2');
      // Now active board is board 2 — board 1 note should not appear
      expect(getActiveNoteOrder()).toEqual([]);
      expect(getActiveNotes()[noteOnBoard1]).toBeUndefined();

      // Switch back to board 1
      store.setActiveBoard(board1Id);
      expect(getActiveNoteOrder()).toContain(noteOnBoard1);
      expect(getActiveNotes()[noteOnBoard1]).toBeDefined();
    });
  });

  describe('persistence', () => {
    it('gets and loads snapshot', () => {
      const store = useWhiteboardStore.getState();
      const noteId = store.addNote(100, 200, 'green');
      store.setNoteContent(noteId, 'Test content');
      store.setVisibility(true);

      const snapshot = store.getSnapshot();
      expect(snapshot.boards).toBeDefined();
      expect(Object.keys(snapshot.boards).length).toBeGreaterThan(0);
      expect(snapshot.isVisible).toBe(true);

      // Verify note is inside board
      const boardId = snapshot.boardOrder[0]!;
      expect(snapshot.boards[boardId]!.notes[noteId]).toBeDefined();
      expect(snapshot.boards[boardId]!.notes[noteId]!.x).toBe(100);
      expect(snapshot.boards[boardId]!.notes[noteId]!.color).toBe('green');
      expect(snapshot.boards[boardId]!.notes[noteId]!.content).toBe('Test content');

      // Reset and load
      store.reset();
      const resetState = useWhiteboardStore.getState();
      const resetBoard = resetState.boards[resetState.boardOrder[0]!]!;
      expect(Object.keys(resetBoard.notes).length).toBe(0);

      useWhiteboardStore.getState().loadSnapshot(snapshot);
      const state = useWhiteboardStore.getState();
      const loadedBoard = state.boards[state.boardOrder[0]!]!;
      expect(loadedBoard.notes[noteId]).toBeDefined();
      expect(loadedBoard.notes[noteId]!.x).toBe(100);
      expect(loadedBoard.notes[noteId]!.color).toBe('green');
      expect(loadedBoard.notes[noteId]!.content).toBe('Test content');
      expect(state.isVisible).toBe(true);
    });

    it('loads legacy snapshot (auto-migration)', () => {
      const store = useWhiteboardStore.getState();
      const noteId = 'legacy-note-1';
      const legacySnapshot = {
        notes: {
          [noteId]: {
            id: noteId,
            x: 50,
            y: 75,
            width: 200,
            height: 150,
            color: '#fef08a',
            content: 'Legacy note',
            zIndex: 1,
            createdAt: Date.now(),
            modifiedAt: Date.now(),
          },
        },
        noteOrder: [noteId],
        isVisible: false,
      };

      store.loadSnapshot(legacySnapshot as never);

      const state = useWhiteboardStore.getState();
      expect(state.boardOrder.length).toBe(1);
      const board = state.boards[state.boardOrder[0]!]!;
      expect(board.notes[noteId]).toBeDefined();
      expect(board.notes[noteId]!.content).toBe('Legacy note');
      expect(board.noteOrder).toContain(noteId);
    });

    it('clears all notes on active board', () => {
      const store = useWhiteboardStore.getState();
      store.addNote(0, 0);
      store.addNote(10, 10);
      store.addNote(20, 20);

      expect(Object.keys(getActiveNotes()).length).toBe(3);

      store.clear();

      expect(Object.keys(getActiveNotes()).length).toBe(0);
      expect(getActiveNoteOrder().length).toBe(0);
    });
  });
});

describe('Whiteboard types', () => {
  it('creates empty whiteboard state with default board', () => {
    const state = createEmptyWhiteboardState();
    expect(state.boards).toBeDefined();
    expect(state.boardOrder.length).toBe(1);
    expect(state.activeBoardId).toBe(state.boardOrder[0]);
    expect(state.isVisible).toBe(false);

    const board = state.boards[state.boardOrder[0]!]!;
    expect(board.notes).toEqual({});
    expect(board.noteOrder).toEqual([]);
  });

  it('creates note with defaults', () => {
    const note = createNote('test-id', 100, 200);
    expect(note.id).toBe('test-id');
    expect(note.x).toBe(100);
    expect(note.y).toBe(200);
    expect(note.width).toBe(DEFAULT_NOTE_WIDTH);
    expect(note.height).toBe(DEFAULT_NOTE_HEIGHT);
    expect(note.color).toBe(DEFAULT_NOTE_COLOR);
    expect(note.content).toBe('');
    expect(note.zIndex).toBe(1);
    expect(note.createdAt).toBeDefined();
    expect(note.modifiedAt).toBeDefined();
  });

  it('creates note with custom color', () => {
    const note = createNote('test-id', 0, 0, 'blue');
    expect(note.color).toBe('blue');
  });
});
