/**
 * Custom shape library store for managing user-created shape libraries.
 *
 * Libraries are stored in localStorage (via Zustand persist).
 * Shape items are stored in IndexedDB (via BlobStorage).
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { nanoid } from 'nanoid';
import type {
  CustomShapeLibrary,
  CustomShapeItem,
  SerializedShapeData,
  SaveToLibraryResult,
  ShapeLibraryExport,
} from '../storage/ShapeLibraryTypes';
import { isValidShapeLibraryExport } from '../storage/ShapeLibraryTypes';
import { blobStorage } from '../storage/BlobStorage';
import { serializeShapes, generateThumbnail, getSerializedShapeType } from '../utils/shapeSerializer';
import type { Shape } from '../shapes/Shape';

/**
 * Custom shape library state.
 */
export interface CustomShapeLibraryState {
  /** User-created libraries */
  libraries: CustomShapeLibrary[];
  /** Cached item metadata (loaded from IndexedDB) */
  itemsCache: Record<string, CustomShapeItem>;
  /** Currently selected library ID (for UI) */
  selectedLibraryId: string | null;
  /** Loading state */
  isLoading: boolean;
  /** Initialization state */
  isInitialized: boolean;
  /** Error message */
  error: string | null;
}

/**
 * Custom shape library actions.
 */
export interface CustomShapeLibraryActions {
  /** Initialize the store (load items from IndexedDB) */
  initialize: () => Promise<void>;

  // Library management
  /** Create a new library */
  createLibrary: (name: string, description?: string) => string;
  /** Rename a library */
  renameLibrary: (id: string, name: string) => void;
  /** Update library description */
  updateLibraryDescription: (id: string, description: string) => void;
  /** Delete a library and all its items */
  deleteLibrary: (id: string) => Promise<void>;
  /** Get a library by ID */
  getLibrary: (id: string) => CustomShapeLibrary | undefined;
  /** Get all libraries */
  getAllLibraries: () => CustomShapeLibrary[];

  // Item management
  /** Save shapes to a library */
  saveToLibrary: (
    libraryId: string,
    name: string,
    selectedIds: string[],
    allShapes: Record<string, Shape>
  ) => Promise<SaveToLibraryResult>;
  /** Delete an item from a library */
  deleteItem: (itemId: string) => Promise<void>;
  /** Rename an item */
  renameItem: (itemId: string, name: string) => Promise<void>;
  /** Get items for a library */
  getLibraryItems: (libraryId: string) => CustomShapeItem[];
  /** Get all items */
  getAllItems: () => CustomShapeItem[];
  /** Load shape data for an item */
  loadItemData: (itemId: string) => Promise<SerializedShapeData | null>;
  /** Increment usage count for an item */
  incrementItemUsage: (itemId: string) => Promise<void>;

  // Export/Import
  /** Export a library to JSON blob */
  exportLibrary: (libraryId: string) => Promise<Blob | null>;
  /** Import a library from JSON file */
  importLibrary: (file: File) => Promise<{ success: boolean; error?: string; libraryId?: string }>;

  // UI state
  /** Select a library */
  selectLibrary: (id: string | null) => void;
  /** Clear error */
  clearError: () => void;
}

/**
 * Initial state.
 */
const initialState: CustomShapeLibraryState = {
  libraries: [],
  itemsCache: {},
  selectedLibraryId: null,
  isLoading: false,
  isInitialized: false,
  error: null,
};

/**
 * Custom shape library store.
 */
export const useCustomShapeLibraryStore = create<CustomShapeLibraryState & CustomShapeLibraryActions>()(
  persist(
    (set, get) => ({
      // State
      ...initialState,

      // Actions
      initialize: async () => {
        const state = get();
        if (state.isInitialized) return;

        set({ isLoading: true, error: null });

        try {
          // Load all shape items from IndexedDB
          const items = await blobStorage.listAllShapeItems();
          const itemsCache: Record<string, CustomShapeItem> = {};

          for (const item of items) {
            itemsCache[item.id] = item;
          }

          // Update library item counts
          const { libraries } = get();
          const updatedLibraries = libraries.map((lib) => ({
            ...lib,
            itemCount: items.filter((item) => item.libraryId === lib.id).length,
          }));

          set({
            itemsCache,
            libraries: updatedLibraries,
            isLoading: false,
            isInitialized: true,
          });
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to load shape library',
            isLoading: false,
            isInitialized: true,
          });
        }
      },

      // Library management
      createLibrary: (name: string, description?: string) => {
        const id = nanoid();
        const now = Date.now();

        const library: CustomShapeLibrary = {
          id,
          name,
          ...(description ? { description } : {}),
          createdAt: now,
          modifiedAt: now,
          itemCount: 0,
        };

        set((state) => ({
          libraries: [...state.libraries, library],
          selectedLibraryId: id,
        }));

        return id;
      },

      renameLibrary: (id: string, name: string) => {
        set((state) => ({
          libraries: state.libraries.map((lib) =>
            lib.id === id ? { ...lib, name, modifiedAt: Date.now() } : lib
          ),
        }));
      },

      updateLibraryDescription: (id: string, description: string) => {
        set((state) => ({
          libraries: state.libraries.map((lib) =>
            lib.id === id ? { ...lib, description, modifiedAt: Date.now() } : lib
          ),
        }));
      },

      deleteLibrary: async (id: string) => {
        try {
          // Delete all items in the library from IndexedDB
          await blobStorage.deleteShapeItemsByLibrary(id);

          // Remove from state
          set((state) => ({
            libraries: state.libraries.filter((lib) => lib.id !== id),
            itemsCache: Object.fromEntries(
              Object.entries(state.itemsCache).filter(([, item]) => item.libraryId !== id)
            ),
            selectedLibraryId:
              state.selectedLibraryId === id ? null : state.selectedLibraryId,
          }));
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to delete library',
          });
        }
      },

      getLibrary: (id: string) => {
        return get().libraries.find((lib) => lib.id === id);
      },

      getAllLibraries: () => {
        return get().libraries;
      },

      // Item management
      saveToLibrary: async (
        libraryId: string,
        name: string,
        selectedIds: string[],
        allShapes: Record<string, Shape>
      ): Promise<SaveToLibraryResult> => {
        try {
          // Serialize shapes
          const shapeData = serializeShapes(selectedIds, allShapes);
          if (!shapeData) {
            return { success: false, error: 'No shapes to save' };
          }

          // Generate thumbnail
          const selectedShapes = selectedIds
            .map((id) => allShapes[id])
            .filter((s): s is Shape => s !== undefined);
          const thumbnail = generateThumbnail(selectedShapes, allShapes, 64);

          // Create item
          const item: CustomShapeItem = {
            id: nanoid(),
            libraryId,
            name,
            type: getSerializedShapeType(shapeData),
            ...(thumbnail ? { thumbnail } : {}),
            createdAt: Date.now(),
            usageCount: 0,
            shapeData,
          };

          // Save to IndexedDB
          await blobStorage.saveShapeItem(item);

          // Update state
          set((state) => ({
            itemsCache: { ...state.itemsCache, [item.id]: item },
            libraries: state.libraries.map((lib) =>
              lib.id === libraryId
                ? { ...lib, itemCount: lib.itemCount + 1, modifiedAt: Date.now() }
                : lib
            ),
          }));

          return { success: true, itemId: item.id };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to save to library',
          };
        }
      },

      deleteItem: async (itemId: string) => {
        const item = get().itemsCache[itemId];
        if (!item) return;

        try {
          // Delete from IndexedDB
          await blobStorage.deleteShapeItem(itemId);

          // Update state
          set((state) => {
            const { [itemId]: _, ...remainingItems } = state.itemsCache;
            return {
              itemsCache: remainingItems,
              libraries: state.libraries.map((lib) =>
                lib.id === item.libraryId
                  ? { ...lib, itemCount: Math.max(0, lib.itemCount - 1), modifiedAt: Date.now() }
                  : lib
              ),
            };
          });
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to delete item',
          });
        }
      },

      renameItem: async (itemId: string, name: string) => {
        const item = get().itemsCache[itemId];
        if (!item) return;

        try {
          const updatedItem = { ...item, name };
          await blobStorage.saveShapeItem(updatedItem);

          set((state) => ({
            itemsCache: { ...state.itemsCache, [itemId]: updatedItem },
          }));
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to rename item',
          });
        }
      },

      getLibraryItems: (libraryId: string) => {
        const { itemsCache } = get();
        return Object.values(itemsCache)
          .filter((item) => item.libraryId === libraryId)
          .sort((a, b) => b.createdAt - a.createdAt);
      },

      getAllItems: () => {
        return Object.values(get().itemsCache);
      },

      loadItemData: async (itemId: string): Promise<SerializedShapeData | null> => {
        // Check cache first
        const cached = get().itemsCache[itemId];
        if (cached) {
          return cached.shapeData;
        }

        // Load from IndexedDB
        const item = await blobStorage.loadShapeItem(itemId);
        if (!item) return null;

        // Update cache
        set((state) => ({
          itemsCache: { ...state.itemsCache, [itemId]: item },
        }));

        return item.shapeData;
      },

      incrementItemUsage: async (itemId: string) => {
        const item = get().itemsCache[itemId];
        if (!item) return;

        try {
          const updatedItem = { ...item, usageCount: item.usageCount + 1 };
          await blobStorage.saveShapeItem(updatedItem);

          set((state) => ({
            itemsCache: { ...state.itemsCache, [itemId]: updatedItem },
          }));
        } catch {
          // Ignore errors for usage tracking
        }
      },

      // Export/Import
      exportLibrary: async (libraryId: string): Promise<Blob | null> => {
        const library = get().getLibrary(libraryId);
        if (!library) return null;

        const items = get().getLibraryItems(libraryId);

        const exportData: ShapeLibraryExport = {
          version: 1,
          type: 'docushark-shape-library',
          library: {
            id: library.id,
            name: library.name,
            ...(library.description ? { description: library.description } : {}),
            createdAt: library.createdAt,
          },
          items: items.map((item) => ({
            name: item.name,
            type: item.type,
            ...(item.thumbnail ? { thumbnail: item.thumbnail } : {}),
            shapeData: item.shapeData,
          })),
        };

        return new Blob([JSON.stringify(exportData, null, 2)], {
          type: 'application/json',
        });
      },

      importLibrary: async (file: File) => {
        try {
          const text = await file.text();
          const data = JSON.parse(text);

          if (!isValidShapeLibraryExport(data)) {
            return { success: false, error: 'Invalid library file format' };
          }

          // Create new library with new ID
          const libraryId = nanoid();
          const now = Date.now();

          const library: CustomShapeLibrary = {
            id: libraryId,
            name: data.library.name,
            ...(data.library.description ? { description: data.library.description } : {}),
            createdAt: now,
            modifiedAt: now,
            itemCount: data.items.length,
          };

          // Import all items
          const importedItems: CustomShapeItem[] = [];
          for (const itemData of data.items) {
            const item: CustomShapeItem = {
              id: nanoid(),
              libraryId,
              name: itemData.name,
              type: itemData.type,
              ...(itemData.thumbnail ? { thumbnail: itemData.thumbnail } : {}),
              createdAt: now,
              usageCount: 0,
              shapeData: itemData.shapeData,
            };

            await blobStorage.saveShapeItem(item);
            importedItems.push(item);
          }

          // Update state
          set((state) => {
            const newItemsCache = { ...state.itemsCache };
            for (const item of importedItems) {
              newItemsCache[item.id] = item;
            }
            return {
              libraries: [...state.libraries, library],
              itemsCache: newItemsCache,
              selectedLibraryId: libraryId,
            };
          });

          return { success: true, libraryId };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to import library',
          };
        }
      },

      // UI state
      selectLibrary: (id: string | null) => {
        set({ selectedLibraryId: id });
      },

      clearError: () => {
        set({ error: null });
      },
    }),
    {
      name: 'docushark-custom-shape-library',
      partialize: (state) => ({
        libraries: state.libraries,
        selectedLibraryId: state.selectedLibraryId,
      }),
    }
  )
);

/**
 * Initialize the custom shape library store.
 * Call this on app startup.
 */
export async function initializeCustomShapeLibrary(): Promise<void> {
  await useCustomShapeLibraryStore.getState().initialize();
}
