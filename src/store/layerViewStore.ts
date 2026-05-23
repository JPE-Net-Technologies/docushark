/**
 * Store for managing layer views - filtered subsets of layers in the LayerPanel.
 * Views can filter by regex pattern matching shape types/names, and/or manual additions.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { nanoid } from 'nanoid';
import { Shape, isGroup, GroupShape } from '../shapes/Shape';

/**
 * A layer view definition that filters which shapes appear in the layer panel.
 */
export interface LayerView {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Optional regex pattern to match shape types/names (case-insensitive) */
  regexPattern?: string;
  /** Manually added shape IDs */
  manualShapeIds: string[];
  /** Creation timestamp */
  createdAt: number;
}

interface LayerViewState {
  /** All layer views */
  views: LayerView[];
  /** Currently active view ID (null = show all) */
  activeViewId: string | null;
}

interface LayerViewActions {
  /** Create a new view and return its ID */
  createView: (name: string, regexPattern?: string) => string;
  /** Update an existing view */
  updateView: (id: string, updates: Partial<Omit<LayerView, 'id' | 'createdAt'>>) => void;
  /** Delete a view */
  deleteView: (id: string) => void;
  /** Add a shape to a view's manual list */
  addShapeToView: (viewId: string, shapeId: string) => void;
  /** Remove a shape from a view's manual list */
  removeShapeFromView: (viewId: string, shapeId: string) => void;
  /** Toggle a shape in a view's manual list */
  toggleShapeInView: (viewId: string, shapeId: string) => void;
  /** Set the active view (null to show all) */
  setActiveView: (viewId: string | null) => void;
  /** Get a specific view by ID */
  getView: (id: string) => LayerView | undefined;
  /** Get all views */
  getAllViews: () => LayerView[];
  /** Check if a shape is in a view's manual list */
  isShapeInView: (viewId: string, shapeId: string) => boolean;
}

/**
 * Get the preview text for a shape (label, text content, etc.)
 */
function getShapePreviewText(shape: Shape): string | null {
  if ('label' in shape && typeof shape.label === 'string' && shape.label.trim()) {
    return shape.label.trim();
  }
  if ('text' in shape && typeof shape.text === 'string' && shape.text.trim()) {
    return shape.text.trim();
  }
  return null;
}

/**
 * Get all shape IDs that match a view's criteria.
 * Returns shape IDs from both regex matching and manual additions.
 */
export function getMatchingShapeIds(
  view: LayerView,
  shapes: Record<string, Shape>,
  shapeOrder: string[]
): string[] {
  const matchingIds = new Set<string>();

  // Add manual additions (if they still exist)
  for (const id of view.manualShapeIds) {
    if (shapes[id]) {
      matchingIds.add(id);
    }
  }

  // Match regex pattern against shape type, group name, and label content
  if (view.regexPattern) {
    try {
      const regex = new RegExp(view.regexPattern, 'i');

      // Helper to recursively add matching shapes including children
      const addMatchingShape = (id: string) => {
        const shape = shapes[id];
        if (!shape) return;

        // Check if shape matches
        let matches = false;

        // Match against type
        if (regex.test(shape.type)) {
          matches = true;
        }

        // Match against group name
        if (!matches && isGroup(shape)) {
          const group = shape as GroupShape;
          if (group.name && regex.test(group.name)) {
            matches = true;
          }
        }

        // Match against label/text content
        if (!matches) {
          const preview = getShapePreviewText(shape);
          if (preview && regex.test(preview)) {
            matches = true;
          }
        }

        if (matches) {
          matchingIds.add(id);
        }
      };

      // Check all top-level shapes and their children
      for (const id of shapeOrder) {
        addMatchingShape(id);
      }

      // Also check children of groups
      for (const shape of Object.values(shapes)) {
        if (isGroup(shape)) {
          for (const childId of shape.childIds) {
            addMatchingShape(childId);
          }
        }
      }
    } catch {
      // Invalid regex - skip pattern matching
    }
  }

  // Return in original order
  const allIds = new Set([...shapeOrder]);
  for (const shape of Object.values(shapes)) {
    if (isGroup(shape)) {
      for (const childId of shape.childIds) {
        allIds.add(childId);
      }
    }
  }

  return Array.from(allIds).filter((id) => matchingIds.has(id));
}

/**
 * Validate a regex pattern. Returns true if valid, false otherwise.
 */
export function isValidRegex(pattern: string): boolean {
  if (!pattern) return true;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export const useLayerViewStore = create<LayerViewState & LayerViewActions>()(
  persist(
    (set, get) => ({
      views: [],
      activeViewId: null,

      createView: (name: string, regexPattern?: string) => {
        const id = nanoid();
        const newView: LayerView = {
          id,
          name,
          manualShapeIds: [],
          createdAt: Date.now(),
          ...(regexPattern ? { regexPattern } : {}),
        };
        set((state) => ({
          views: [...state.views, newView],
        }));
        return id;
      },

      updateView: (id: string, updates: Partial<Omit<LayerView, 'id' | 'createdAt'>>) => {
        set((state) => ({
          views: state.views.map((view) =>
            view.id === id ? { ...view, ...updates } : view
          ),
        }));
      },

      deleteView: (id: string) => {
        set((state) => ({
          views: state.views.filter((view) => view.id !== id),
          // Clear active view if it was deleted
          activeViewId: state.activeViewId === id ? null : state.activeViewId,
        }));
      },

      addShapeToView: (viewId: string, shapeId: string) => {
        set((state) => ({
          views: state.views.map((view) =>
            view.id === viewId && !view.manualShapeIds.includes(shapeId)
              ? { ...view, manualShapeIds: [...view.manualShapeIds, shapeId] }
              : view
          ),
        }));
      },

      removeShapeFromView: (viewId: string, shapeId: string) => {
        set((state) => ({
          views: state.views.map((view) =>
            view.id === viewId
              ? { ...view, manualShapeIds: view.manualShapeIds.filter((id) => id !== shapeId) }
              : view
          ),
        }));
      },

      toggleShapeInView: (viewId: string, shapeId: string) => {
        const state = get();
        const view = state.views.find((v) => v.id === viewId);
        if (!view) return;

        if (view.manualShapeIds.includes(shapeId)) {
          state.removeShapeFromView(viewId, shapeId);
        } else {
          state.addShapeToView(viewId, shapeId);
        }
      },

      setActiveView: (viewId: string | null) => {
        set({ activeViewId: viewId });
      },

      getView: (id: string) => {
        return get().views.find((view) => view.id === id);
      },

      getAllViews: () => {
        return get().views;
      },

      isShapeInView: (viewId: string, shapeId: string) => {
        const view = get().views.find((v) => v.id === viewId);
        return view ? view.manualShapeIds.includes(shapeId) : false;
      },
    }),
    {
      name: 'docushark-layer-views',
      partialize: (state) => ({
        views: state.views,
        activeViewId: state.activeViewId,
      }),
    }
  )
);