import { create } from 'zustand';
import { useDocumentStore } from './documentStore';
import { shapeRegistry } from '../shapes/ShapeRegistry';
import type { Shape } from '../shapes/Shape';
import type { RelaxedFocus } from '../ui/layout/types';

/**
 * Core tool types that are always available.
 */
export const CORE_TOOLS = [
  'select',
  'pan',
  'rectangle',
  'ellipse',
  'line',
  'text',
  'connector',
] as const;

/**
 * Type for core tools (select, pan, etc.)
 */
export type CoreToolType = (typeof CORE_TOOLS)[number];

/**
 * Tool type - now allows any registered shape type.
 *
 * Core tools (select, pan, rectangle, ellipse, line, text, connector) are always valid.
 * Library shape types (diamond, terminator, etc.) are valid when registered.
 */
export type ToolType = string;

/**
 * Check if a string is a valid tool type.
 *
 * @param type - The tool type to validate
 * @returns true if the type is a core tool or a registered shape type
 */
export function isValidToolType(type: string): boolean {
  return (
    CORE_TOOLS.includes(type as CoreToolType) || shapeRegistry.hasHandler(type)
  );
}

/**
 * Check if a tool type is a core tool.
 */
export function isCoreToolType(type: string): type is CoreToolType {
  return CORE_TOOLS.includes(type as CoreToolType);
}

/**
 * Camera state representing the viewport.
 */
export interface CameraState {
  /** X position in world coordinates */
  x: number;
  /** Y position in world coordinates */
  y: number;
  /** Zoom level (1.0 = 100%) */
  zoom: number;
}

/**
 * Cursor style options.
 */
export type CursorStyle =
  | 'default'
  | 'pointer'
  | 'grab'
  | 'grabbing'
  | 'crosshair'
  | 'move'
  | 'text'
  | 'not-allowed'
  | 'nwse-resize'
  | 'nesw-resize'
  | 'ns-resize'
  | 'ew-resize';

/**
 * Snapping settings.
 */
export interface SnapSettings {
  /** Whether snapping is enabled */
  enabled: boolean;
  /** Whether to snap to grid */
  snapToGrid: boolean;
  /** Whether to snap to other shapes */
  snapToShapes: boolean;
  /** Grid spacing for snapping */
  gridSpacing: number;
}

/**
 * Active snap guide lines for rendering.
 */
export interface SnapGuides {
  /** Vertical guide line X position */
  verticalX?: number;
  /** Horizontal guide line Y position */
  horizontalY?: number;
}

/**
 * Session state for ephemeral UI state.
 * This is NOT persisted - it's reset on page reload.
 */
export interface SessionState {
  /** Currently selected shape IDs */
  selectedIds: Set<string>;
  /** Camera/viewport state */
  camera: CameraState;
  /** Per-page camera states (for restoring when switching pages) */
  pageCameras: Record<string, CameraState>;
  /** Per-page Tiptap editor scroll positions */
  editorScrollPositions: Record<string, number>;
  /** Currently active tool */
  activeTool: ToolType;
  /** Current cursor style */
  cursor: CursorStyle;
  /** Whether the user is currently interacting (dragging, etc.) */
  isInteracting: boolean;
  /** ID of shape being hovered over (for highlighting) */
  hoveredId: string | null;
  /** ID of text shape currently being edited (null if not editing) */
  editingTextId: string | null;
  /** ID of file shape currently being viewed in modal (null if not viewing) */
  viewingFileShapeId: string | null;
  /** Snapping settings */
  snapSettings: SnapSettings;
  /** Active snap guides for visual feedback */
  snapGuides: SnapGuides;
  /** ID of shape that should be visually emphasized (for focus animation) */
  emphasizedShapeId: string | null;
  /**
   * Ephemeral per-shape style overrides for live preview (e.g. hovering a style
   * profile in the panel). Keyed by shape id. Applied by the renderer on top of
   * the real shape — never written to the document, CRDT, or history, so peers
   * in a collab session never see it.
   */
  stylePreviewOverrides: Record<string, Partial<Shape>>;
  /** Current cursor position in world coordinates (for status bar display) */
  cursorWorldPosition: { x: number; y: number } | null;
  /** Blob sync progress (for status bar display during file sync) */
  blobSyncProgress: {
    phase: 'checking' | 'uploading' | 'downloading';
    current: number;
    total: number;
  } | null;
  /**
   * Transient group-edit context. When set, the user has drilled into this
   * group; clicks inside the group's subtree select the directly-hit shape
   * instead of re-resolving up to the group root. Cleared on outside-click,
   * Escape, tool switch, selection clear, or deletion of the group.
   */
  editingGroupId: string | null;
  /**
   * Focus within the writing-first Relaxed layout (prose / split / diagram).
   * App-level and ephemeral — resets to 'write' on reload. Ignored outside the
   * Relaxed layout. See `resolveRegions` in ui/layout/modes.ts.
   */
  relaxedFocus: RelaxedFocus;
}

/**
 * Actions for modifying session state.
 */
export interface SessionActions {
  // Selection
  select: (ids: string[]) => void;
  addToSelection: (ids: string[]) => void;
  removeFromSelection: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  selectAll: () => void;

  // Camera
  setCamera: (camera: Partial<CameraState>) => void;
  resetCamera: () => void;

  // Tool
  setActiveTool: (tool: ToolType) => void;

  // Cursor
  setCursor: (cursor: CursorStyle) => void;

  // Interaction state
  setIsInteracting: (isInteracting: boolean) => void;

  // Hover
  setHoveredId: (id: string | null) => void;

  // Text editing
  startTextEdit: (id: string) => void;
  stopTextEdit: () => void;
  isEditingText: () => boolean;

  // File viewing
  openFileViewer: (id: string) => void;
  closeFileViewer: () => void;
  isViewingFile: () => boolean;

  // Snapping
  setSnapSettings: (settings: Partial<SnapSettings>) => void;
  setSnapGuides: (guides: SnapGuides) => void;
  clearSnapGuides: () => void;

  // Ephemeral style preview (collab-safe; render-only)
  /** Set per-shape style overrides for live preview. Replaces the whole map. */
  setStylePreview: (overrides: Record<string, Partial<Shape>>) => void;
  /** Clear all live-preview overrides. */
  clearStylePreview: () => void;

  // Focus/Emphasis
  /** Focus camera on a shape and trigger emphasis animation */
  focusOnShape: (id: string) => void;
  /** Clear the emphasis animation */
  clearEmphasis: () => void;

  // Cursor Position
  /** Set cursor world position (for status bar display) */
  setCursorWorldPosition: (pos: { x: number; y: number } | null) => void;

  // Blob Sync Progress
  /** Set blob sync progress (for status bar display) */
  setBlobSyncProgress: (progress: { phase: 'checking' | 'uploading' | 'downloading'; current: number; total: number } | null) => void;

  // Group drill-down
  /** Enter or exit transient group-edit context. */
  setEditingGroupId: (id: string | null) => void;

  // Relaxed-layout focus
  /** Set the Relaxed layout focus (prose / split / diagram). */
  setRelaxedFocus: (focus: RelaxedFocus) => void;
  /** Advance the Relaxed focus write → split → diagram → write. */
  cycleRelaxedFocus: () => void;

  // Page Camera
  /** Save current camera state for a page */
  savePageCamera: (pageId: string) => void;
  /** Restore camera state for a page (if saved) */
  restorePageCamera: (pageId: string) => void;

  // Editor Scroll Position
  /** Save Tiptap editor scroll position for a page */
  saveEditorScroll: (pageId: string, scrollTop: number) => void;
  /** Get saved editor scroll position for a page (undefined if none saved) */
  getEditorScroll: (pageId: string) => number | undefined;

  // Utilities
  isSelected: (id: string) => boolean;
  getSelectedIds: () => string[];
  hasSelection: () => boolean;
  reset: () => void;
}

/**
 * Default camera state.
 */
const DEFAULT_CAMERA: CameraState = {
  x: 0,
  y: 0,
  zoom: 1,
};

/**
 * Default snap settings.
 */
const DEFAULT_SNAP_SETTINGS: SnapSettings = {
  enabled: true,
  snapToGrid: true,
  snapToShapes: true,
  gridSpacing: 50,
};

/**
 * Initial session state.
 */
const initialState: SessionState = {
  selectedIds: new Set(),
  camera: { ...DEFAULT_CAMERA },
  pageCameras: {},
  editorScrollPositions: {},
  activeTool: 'select',
  cursor: 'default',
  isInteracting: false,
  hoveredId: null,
  editingTextId: null,
  viewingFileShapeId: null,
  snapSettings: { ...DEFAULT_SNAP_SETTINGS },
  snapGuides: {},
  emphasizedShapeId: null,
  stylePreviewOverrides: {},
  cursorWorldPosition: null,
  blobSyncProgress: null,
  editingGroupId: null,
  relaxedFocus: 'write',
};

/**
 * Session store for ephemeral UI state.
 *
 * Manages selection, camera state, active tool, cursor, and interaction state.
 * This state is NOT persisted - it's reset on page reload.
 *
 * Usage:
 * ```typescript
 * const { selectedIds, select, activeTool } = useSessionStore();
 *
 * // Select shapes
 * select(['shape1', 'shape2']);
 *
 * // Check selection
 * const isSelected = useSessionStore(state => state.isSelected('shape1'));
 *
 * // Change tool
 * setActiveTool('rectangle');
 * ```
 */
export const useSessionStore = create<SessionState & SessionActions>()((set, get) => ({
  // State
  ...initialState,

  // Selection actions
  select: (ids: string[]) => {
    set({ selectedIds: new Set(ids) });
  },

  addToSelection: (ids: string[]) => {
    set((state) => {
      const newSet = new Set(state.selectedIds);
      for (const id of ids) {
        newSet.add(id);
      }
      return { selectedIds: newSet };
    });
  },

  removeFromSelection: (ids: string[]) => {
    set((state) => {
      const newSet = new Set(state.selectedIds);
      for (const id of ids) {
        newSet.delete(id);
      }
      return { selectedIds: newSet };
    });
  },

  toggleSelection: (id: string) => {
    set((state) => {
      const newSet = new Set(state.selectedIds);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return { selectedIds: newSet };
    });
  },

  clearSelection: () => {
    set({ selectedIds: new Set(), editingGroupId: null });
  },

  selectAll: () => {
    const documentState = useDocumentStore.getState();
    set({ selectedIds: new Set(documentState.shapeOrder) });
  },

  // Camera actions
  setCamera: (camera: Partial<CameraState>) => {
    set((state) => ({
      camera: { ...state.camera, ...camera },
    }));
  },

  resetCamera: () => {
    set({ camera: { ...DEFAULT_CAMERA } });
  },

  // Tool actions
  setActiveTool: (tool: ToolType) => {
    // Leaving the select tool exits any drill-down context.
    set({ activeTool: tool, editingGroupId: null });
  },

  // Cursor actions
  setCursor: (cursor: CursorStyle) => {
    set({ cursor });
  },

  // Interaction state
  setIsInteracting: (isInteracting: boolean) => {
    set({ isInteracting });
  },

  // Hover
  setHoveredId: (id: string | null) => {
    set({ hoveredId: id });
  },

  // Text editing
  startTextEdit: (id: string) => {
    set({ editingTextId: id });
  },

  stopTextEdit: () => {
    set({ editingTextId: null });
  },

  isEditingText: (): boolean => {
    return get().editingTextId !== null;
  },

  // File viewing
  openFileViewer: (id: string) => {
    set({ viewingFileShapeId: id });
  },

  closeFileViewer: () => {
    set({ viewingFileShapeId: null });
  },

  isViewingFile: (): boolean => {
    return get().viewingFileShapeId !== null;
  },

  // Snapping
  setSnapSettings: (settings: Partial<SnapSettings>) => {
    set((state) => ({
      snapSettings: { ...state.snapSettings, ...settings },
    }));
  },

  setSnapGuides: (guides: SnapGuides) => {
    set({ snapGuides: guides });
  },

  clearSnapGuides: () => {
    set({ snapGuides: {} });
  },

  setStylePreview: (overrides: Record<string, Partial<Shape>>) => {
    set({ stylePreviewOverrides: overrides });
  },

  clearStylePreview: () => {
    // Avoid a needless render churn when already empty.
    if (Object.keys(get().stylePreviewOverrides).length === 0) return;
    set({ stylePreviewOverrides: {} });
  },

  // Focus/Emphasis
  focusOnShape: (id: string) => {
    const shape = useDocumentStore.getState().shapes[id];
    if (!shape) return;

    // Calculate the center of the shape
    // Simple approach: use x, y as the center (works for most shapes)
    // For more accuracy, we'd need to get the bounds via ShapeRegistry
    let centerX = shape.x;
    let centerY = shape.y;

    // Adjust for shapes that use top-left positioning
    if (shape.type === 'rectangle') {
      // Rectangle x,y is at center, so no adjustment needed
    } else if (shape.type === 'line') {
      // Line: use midpoint
      const lineShape = shape as { x: number; y: number; x2: number; y2: number };
      centerX = (lineShape.x + lineShape.x2) / 2;
      centerY = (lineShape.y + lineShape.y2) / 2;
    }

    // Update camera to focus on the shape
    set((state) => ({
      camera: {
        ...state.camera,
        x: centerX,
        y: centerY,
      },
      emphasizedShapeId: id,
    }));

    // Clear emphasis after animation completes
    setTimeout(() => {
      // Only clear if it's still the same shape
      if (get().emphasizedShapeId === id) {
        set({ emphasizedShapeId: null });
      }
    }, 1500);
  },

  clearEmphasis: () => {
    set({ emphasizedShapeId: null });
  },

  // Cursor Position
  setCursorWorldPosition: (pos: { x: number; y: number } | null) => {
    set({ cursorWorldPosition: pos });
  },

  // Blob Sync Progress
  setBlobSyncProgress: (progress: { phase: 'checking' | 'uploading' | 'downloading'; current: number; total: number } | null) => {
    set({ blobSyncProgress: progress });
  },

  // Group drill-down
  setEditingGroupId: (id: string | null) => {
    set({ editingGroupId: id });
  },

  // Relaxed-layout focus
  setRelaxedFocus: (focus: RelaxedFocus) => {
    set({ relaxedFocus: focus });
  },

  cycleRelaxedFocus: () => {
    const order: RelaxedFocus[] = ['write', 'split', 'diagram'];
    const idx = order.indexOf(get().relaxedFocus);
    const next = order[(idx + 1) % order.length] ?? 'write';
    set({ relaxedFocus: next });
  },


  // Page Camera
  savePageCamera: (pageId: string) => {
    set((state) => ({
      pageCameras: {
        ...state.pageCameras,
        [pageId]: { ...state.camera },
      },
    }));
  },

  restorePageCamera: (pageId: string) => {
    const savedCamera = get().pageCameras[pageId];
    if (savedCamera) {
      set({ camera: { ...savedCamera } });
    } else {
      // Reset to default if no saved camera for this page
      set({ camera: { ...DEFAULT_CAMERA } });
    }
  },

  // Editor Scroll Position
  saveEditorScroll: (pageId: string, scrollTop: number) => {
    set((state) => ({
      editorScrollPositions: {
        ...state.editorScrollPositions,
        [pageId]: scrollTop,
      },
    }));
  },

  getEditorScroll: (pageId: string): number | undefined => {
    return get().editorScrollPositions[pageId];
  },

  // Utilities
  isSelected: (id: string): boolean => {
    return get().selectedIds.has(id);
  },

  getSelectedIds: (): string[] => {
    return Array.from(get().selectedIds);
  },

  hasSelection: (): boolean => {
    return get().selectedIds.size > 0;
  },

  reset: () => {
    set({
      ...initialState,
      selectedIds: new Set(),
      pageCameras: {},
      editorScrollPositions: {},
      snapSettings: { ...DEFAULT_SNAP_SETTINGS },
      snapGuides: {},
      cursorWorldPosition: null,
      editingGroupId: null,
    });
  },
}));

/**
 * Get the selected shapes from the document store.
 * Utility for getting actual shape data for selected IDs.
 */
export function getSelectedShapes() {
  const selectedIds = useSessionStore.getState().getSelectedIds();
  const documentState = useDocumentStore.getState();
  return selectedIds
    .map((id) => documentState.shapes[id])
    .filter((shape) => shape !== undefined);
}

/**
 * Check if there's a single shape selected.
 */
export function hasSingleSelection(): boolean {
  return useSessionStore.getState().selectedIds.size === 1;
}

/**
 * Check if there are multiple shapes selected.
 */
export function hasMultipleSelection(): boolean {
  return useSessionStore.getState().selectedIds.size > 1;
}

/**
 * Delete selected shapes from the document.
 * Clears selection after deletion.
 */
export function deleteSelected(): void {
  const selectedIds = useSessionStore.getState().getSelectedIds();
  if (selectedIds.length > 0) {
    useDocumentStore.getState().deleteShapes(selectedIds);
    useSessionStore.getState().clearSelection();
  }
}
