/**
 * Whiteboard type definitions for sticky notes and boards.
 *
 * The whiteboard is a document-global overlay for idea tracking and brainstorming.
 * Notes are NOT canvas shapes - they're separate UI elements for quick drafting.
 * Supports multiple named boards, each with its own set of notes.
 */

/**
 * Default sticky note color (hex).
 */
export const DEFAULT_NOTE_COLOR = '#fef3c7';

/**
 * Preset colors for the note color picker.
 * Curated pastels + a few deeper tones for variety.
 */
export const NOTE_PRESET_COLORS = [
  '#fef3c7', // Amber 100
  '#fde68a', // Amber 200
  '#fce7f3', // Pink 100
  '#fecaca', // Red 200
  '#dbeafe', // Blue 100
  '#bfdbfe', // Blue 200
  '#d1fae5', // Emerald 100
  '#a7f3d0', // Emerald 200
  '#ffedd5', // Orange 100
  '#fed7aa', // Orange 200
  '#e9d5ff', // Violet 100
  '#cffafe', // Cyan 100
  '#f1f5f9', // Slate 100
  '#e2e8f0', // Slate 200
  '#fef9c3', // Yellow 100
  '#1e293b', // Slate 800 — dark option
];

/**
 * A single sticky note on the whiteboard.
 */
export interface WhiteboardNote {
  /** Unique note identifier */
  id: string;
  /** X position in pixels from left */
  x: number;
  /** Y position in pixels from top */
  y: number;
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
  /** Note background color (hex string) */
  color: string;
  /** HTML content (allowed: b, i, u, s, br, strong, em, strike) */
  content: string;
  /** Z-index for stacking order */
  zIndex: number;
  /** Timestamp when created */
  createdAt: number;
  /** Timestamp when last modified */
  modifiedAt: number;
}

/**
 * A whiteboard board — a named collection of sticky notes.
 */
export interface WhiteboardBoard {
  /** Unique board identifier */
  id: string;
  /** Display name */
  name: string;
  /** All notes keyed by ID */
  notes: Record<string, WhiteboardNote>;
  /** Note IDs in z-order (first = bottom) */
  noteOrder: string[];
  /** Timestamp when created */
  createdAt: number;
}

/**
 * Whiteboard state stored in a document.
 *
 * Multi-board format. For backwards compatibility, loadSnapshot
 * auto-migrates the old single-board format (root `notes`/`noteOrder`).
 */
export interface WhiteboardState {
  /** All boards keyed by ID */
  boards: Record<string, WhiteboardBoard>;
  /** Board IDs in display order */
  boardOrder: string[];
  /** Currently active board ID */
  activeBoardId: string | null;
  /** Whether the whiteboard overlay is visible */
  isVisible: boolean;
}

/**
 * Legacy single-board snapshot format (pre-multi-board).
 * Used only for backwards-compatible migration in loadSnapshot.
 */
export interface LegacyWhiteboardSnapshot {
  notes?: Record<string, WhiteboardNote>;
  noteOrder?: string[];
  isVisible?: boolean;
}

/**
 * Default dimensions for new notes.
 */
export const DEFAULT_NOTE_WIDTH = 200;
export const DEFAULT_NOTE_HEIGHT = 150;
export const MIN_NOTE_WIDTH = 100;
export const MIN_NOTE_HEIGHT = 80;

/**
 * Create a new whiteboard board with default values.
 */
export function createBoard(id: string, name: string): WhiteboardBoard {
  return {
    id,
    name,
    notes: {},
    noteOrder: [],
    createdAt: Date.now(),
  };
}

/**
 * Create a new empty whiteboard state with a single default board.
 */
export function createEmptyWhiteboardState(): WhiteboardState {
  const defaultBoard = createBoard('board-1', 'Board 1');
  return {
    boards: { [defaultBoard.id]: defaultBoard },
    boardOrder: [defaultBoard.id],
    activeBoardId: defaultBoard.id,
    isVisible: false,
  };
}

/**
 * Create a new note with default values.
 */
export function createNote(
  id: string,
  x: number,
  y: number,
  color: string = DEFAULT_NOTE_COLOR
): WhiteboardNote {
  const now = Date.now();
  return {
    id,
    x,
    y,
    width: DEFAULT_NOTE_WIDTH,
    height: DEFAULT_NOTE_HEIGHT,
    color,
    content: '',
    zIndex: 1,
    createdAt: now,
    modifiedAt: now,
  };
}

/**
 * Sanitize note content to only allow safe HTML tags.
 * Allowed: <b>, <i>, <u>, <s>, <br>, <strong>, <em>, <strike>
 */
export function sanitizeNoteContent(html: string): string {
  let sanitized = html
    .replace(/<script[^>]*>.*?<\/script>/gi, '')
    .replace(/<style[^>]*>.*?<\/style>/gi, '')
    .replace(/on\w+\s*=/gi, '');

  sanitized = sanitized.replace(/<(\/?)[^>]+>/gi, (match) => {
    const tagMatch = match.match(/<(\/?)(\w+)/);
    if (tagMatch) {
      const tag = tagMatch[2]?.toLowerCase();
      if (tag && ['b', 'i', 'u', 's', 'br', 'strong', 'em', 'strike'].includes(tag)) {
        return match;
      }
    }
    return '';
  });

  return sanitized;
}
