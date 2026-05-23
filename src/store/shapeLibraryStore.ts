/**
 * Shape library store for managing shape library registration.
 *
 * This store handles:
 * - Registering shape definitions with the ShapeRegistry
 * - Tracking registered categories
 * - Providing shape metadata for UI components
 * - Lazy loading of shape libraries on demand
 */

import { create } from 'zustand';
import { shapeRegistry } from '../shapes/ShapeRegistry';
import { createLibraryShapeHandler } from '../shapes/library/LibraryShapeHandler';
import type { LibraryShapeDefinition } from '../shapes/library/ShapeLibraryTypes';
import type { ShapeMetadata, ShapeLibraryCategory } from '../shapes/ShapeMetadata';

/**
 * Lazy library loader configuration.
 */
interface LibraryLoader {
  category: ShapeLibraryCategory;
  load: () => Promise<{ default: LibraryShapeDefinition[] } | LibraryShapeDefinition[]>;
}

/**
 * Available libraries with their lazy loaders.
 */
const LIBRARY_LOADERS: LibraryLoader[] = [
  {
    category: 'flowchart',
    load: () => import('../shapes/library/flowchartShapes').then((m) => m.flowchartShapes),
  },
  {
    category: 'uml-usecase',
    load: () => import('../shapes/library/umlUseCaseShapes').then((m) => m.umlUseCaseShapes),
  },
  {
    category: 'erd',
    load: () => import('../shapes/library/erdShapes').then((m) => m.erdShapes),
  },
  {
    category: 'uml-class',
    load: () => import('../shapes/library/umlClassShapes').then((m) => m.umlClassShapes),
  },
  {
    category: 'uml-sequence',
    load: () => import('../shapes/library/sequenceDiagramShapes').then((m) => m.sequenceDiagramShapes),
  },
  {
    category: 'uml-activity',
    load: () => import('../shapes/library/activityDiagramShapes').then((m) => m.activityDiagramShapes),
  },
];

/**
 * Shape library state.
 */
export interface ShapeLibraryState {
  /** Whether the library has been initialized */
  isInitialized: boolean;
  /** Registered library categories */
  registeredCategories: ShapeLibraryCategory[];
  /** Registered shape definitions (for tool creation) */
  registeredDefinitions: LibraryShapeDefinition[];
  /** Categories currently being loaded */
  loadingCategories: Set<string>;
}

/**
 * Shape library actions.
 */
export interface ShapeLibraryActions {
  /** Initialize the library by registering all shapes */
  initialize: () => void;
  /** Lazy-load and register a specific library category */
  loadCategory: (category: ShapeLibraryCategory) => Promise<void>;
  /** Load all libraries (for initial startup) */
  loadAllLibraries: () => Promise<void>;
  /** Register a single shape definition */
  registerShape: (definition: LibraryShapeDefinition) => void;
  /** Register multiple shape definitions */
  registerShapes: (definitions: LibraryShapeDefinition[]) => void;
  /** Get all library shapes (excluding basic/core shapes) */
  getAllLibraryShapes: () => ShapeMetadata[];
  /** Get shapes by category */
  getShapesByCategory: (category: ShapeLibraryCategory) => ShapeMetadata[];
  /** Get a specific shape definition by type */
  getShapeDefinition: (type: string) => LibraryShapeDefinition | undefined;
  /** Check if a shape type is a library shape */
  isLibraryShape: (type: string) => boolean;
  /** Check if a category is currently loading */
  isCategoryLoading: (category: string) => boolean;
}

/**
 * Initial state.
 */
const initialState: ShapeLibraryState = {
  isInitialized: false,
  registeredCategories: [],
  registeredDefinitions: [],
  loadingCategories: new Set(),
};

/**
 * Shape library store.
 *
 * Usage:
 * ```typescript
 * const { initialize, getAllLibraryShapes } = useShapeLibraryStore();
 *
 * // Initialize on app startup
 * initialize();
 *
 * // Get shapes for ShapePicker UI
 * const shapes = getAllLibraryShapes();
 * ```
 */
export const useShapeLibraryStore = create<ShapeLibraryState & ShapeLibraryActions>()(
  (set, get) => ({
    ...initialState,

    initialize: () => {
      if (get().isInitialized) return;
      // Built-in library shapes are registered eagerly by
      // `src/shapes/registerBuiltInShapes.ts` at module load, so this
      // is now a no-op for the boot-time set. User-defined libraries
      // still go through `loadCategory()` on demand.
      set({ isInitialized: true });
    },

    loadCategory: async (category) => {
      const loader = LIBRARY_LOADERS.find((l) => l.category === category);
      if (!loader) return;

      // Skip if already loading or loaded
      if (get().loadingCategories.has(category)) return;
      if (get().registeredCategories.includes(category)) return;

      set((state) => {
        const newLoading = new Set(state.loadingCategories);
        newLoading.add(category);
        return { loadingCategories: newLoading };
      });

      try {
        const result = await loader.load();
        const definitions = Array.isArray(result) ? result : [];
        get().registerShapes(definitions);
      } catch (e) {
        console.error(`Failed to load shape library: ${category}`, e);
      } finally {
        set((state) => {
          const newLoading = new Set(state.loadingCategories);
          newLoading.delete(category);
          return { loadingCategories: newLoading };
        });
      }
    },

    loadAllLibraries: async () => {
      await Promise.all(
        LIBRARY_LOADERS.map((loader) => get().loadCategory(loader.category))
      );
    },

    registerShape: (definition) => {
      // Skip if already registered
      if (shapeRegistry.hasHandler(definition.type)) {
        return;
      }

      // Create and register handler
      const handler = createLibraryShapeHandler(definition);
      shapeRegistry.register(definition.type, handler, definition.metadata);

      // Update state
      set((state) => {
        const newCategories = state.registeredCategories.includes(definition.metadata.category)
          ? state.registeredCategories
          : [...state.registeredCategories, definition.metadata.category];

        return {
          registeredCategories: newCategories,
          registeredDefinitions: [...state.registeredDefinitions, definition],
        };
      });
    },

    registerShapes: (definitions) => {
      for (const definition of definitions) {
        get().registerShape(definition);
      }
    },

    getAllLibraryShapes: () => {
      // Get all metadata, filter out basic shapes
      return shapeRegistry.getAllMetadata().filter(
        (m) => m.category !== 'basic'
      );
    },

    getShapesByCategory: (category) => {
      return shapeRegistry.getMetadataByCategory(category);
    },

    getShapeDefinition: (type) => {
      return get().registeredDefinitions.find((d) => d.type === type);
    },

    isLibraryShape: (type) => {
      return get().registeredDefinitions.some((d) => d.type === type);
    },

    isCategoryLoading: (category) => {
      return get().loadingCategories.has(category);
    },
  })
);

/**
 * Initialize the shape library.
 * Should be called once on application startup.
 */
export function initializeShapeLibrary(): void {
  useShapeLibraryStore.getState().initialize();
}

/**
 * Get all library shape definitions.
 * Useful for creating tools.
 */
export function getLibraryShapeDefinitions(): LibraryShapeDefinition[] {
  return useShapeLibraryStore.getState().registeredDefinitions;
}
