/**
 * Icon library store for managing built-in and custom icons.
 *
 * Built-in icons are loaded from builtinIcons.ts.
 * Custom icons are stored in IndexedDB via the blob storage system.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  IconMetadata,
  IconCategory,
  IconData,
  IconUploadResult,
  IconLibraryStats,
} from '../storage/IconTypes';
import {
  getBuiltinIcons,
  getBuiltinIcon,
  isBuiltinIcon,
  BUILTIN_ICON_COUNT,
  loadLazyCategory,
  isLazyCategory,
  isCategoryLoaded,
  getLazyIconsByCategory,
  getLoadedLazyIcons,
  getLazyCategoryStates,
  preloadAllLazyCategories,
} from '../storage/builtinIcons';
import { blobStorage } from '../storage/BlobStorage';
import { sanitizeSvg, validateSvg, svgToDataUrl, extractViewBox } from '../utils/svgUtils';

/**
 * Icon library state.
 */
export interface IconLibraryState {
  /** Custom icons (metadata only, content loaded on demand) */
  customIcons: IconMetadata[];
  /** Currently selected icon ID (for UI) */
  selectedIconId: string | null;
  /** Loading state */
  isLoading: boolean;
  /** Error message */
  error: string | null;
  /** Categories currently being loaded */
  loadingCategories: IconCategory[];
  /** Categories that have been loaded */
  loadedCategories: IconCategory[];
}

/**
 * Icon library actions.
 */
export interface IconLibraryActions {
  /** Initialize the store (load custom icons from IndexedDB) */
  initialize: () => Promise<void>;

  /** Get all icons (built-in + custom) */
  getAllIcons: () => IconMetadata[];

  /** Get icons by category */
  getIconsByCategory: (category: IconCategory) => IconMetadata[];

  /** Get a specific icon by ID */
  getIcon: (id: string) => IconMetadata | undefined;

  /** Load icon data (including content) for rendering */
  loadIconData: (id: string) => Promise<IconData | undefined>;

  /** Upload a custom SVG icon */
  uploadIcon: (file: File, name?: string) => Promise<IconUploadResult>;

  /** Delete a custom icon */
  deleteIcon: (id: string) => Promise<boolean>;

  /** Rename a custom icon */
  renameIcon: (id: string, newName: string) => void;

  /** Select an icon (for UI) */
  selectIcon: (id: string | null) => void;

  /** Get library statistics */
  getStats: () => Promise<IconLibraryStats>;

  /** Increment usage count for an icon */
  incrementUsage: (id: string) => void;

  /** Decrement usage count for an icon */
  decrementUsage: (id: string) => void;

  /** Get icons used in documents (for garbage collection) */
  getUsedIconIds: () => string[];

  /** Clear error */
  clearError: () => void;

  /** Load a lazy category (cloud providers, devops, etc.) */
  loadCategory: (category: IconCategory) => Promise<IconMetadata[]>;

  /** Check if a category is loaded */
  isCategoryLoaded: (category: IconCategory) => boolean;

  /** Check if a category is loading */
  isCategoryLoading: (category: IconCategory) => boolean;

  /** Get lazy category states */
  getCategoryStates: () => Array<{
    category: IconCategory;
    loaded: boolean;
    loading: boolean;
    count: number;
  }>;
}

/**
 * Initial state.
 */
const initialState: IconLibraryState = {
  customIcons: [],
  selectedIconId: null,
  isLoading: false,
  error: null,
  loadingCategories: [],
  loadedCategories: [],
};

/**
 * In-memory cache for fetched SVG content (file-based icons).
 */
const svgContentCache = new Map<string, string>();

/**
 * Icon library store.
 *
 * Usage:
 * ```typescript
 * const { getAllIcons, uploadIcon, loadIconData } = useIconLibraryStore();
 *
 * // Get all available icons
 * const icons = getAllIcons();
 *
 * // Upload a new icon
 * const result = await uploadIcon(file);
 *
 * // Load icon data for rendering
 * const data = await loadIconData(iconId);
 * ```
 */
export const useIconLibraryStore = create<IconLibraryState & IconLibraryActions>()(
  persist(
    (set, get) => ({
      // State
      ...initialState,

      // Actions
      initialize: async () => {
        set({ isLoading: true, error: null });

        try {
          // Load custom icon metadata from blob storage
          const blobs = await blobStorage.listAllBlobs();
          const customIcons: IconMetadata[] = [];

          for (const blob of blobs) {
            // Check if this is an SVG icon
            if (blob.type === 'image/svg+xml') {
              customIcons.push({
                id: blob.id,
                name: blob.name.replace(/\.svg$/i, ''),
                type: 'custom',
                category: 'custom',
                blobId: blob.id,
                originalFilename: blob.name,
                createdAt: blob.createdAt,
                usageCount: blob.usageCount,
              });
            }
          }

          set({ customIcons, isLoading: false });
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to load icons',
            isLoading: false,
          });
        }
      },

      getAllIcons: () => {
        const { customIcons } = get();
        // Include core builtin icons + any loaded lazy icons + custom icons
        return [...getBuiltinIcons(), ...getLoadedLazyIcons(), ...customIcons];
      },

      getIconsByCategory: (category: IconCategory) => {
        const { customIcons } = get();

        // Handle lazy categories
        if (isLazyCategory(category)) {
          return getLazyIconsByCategory(category);
        }

        // Handle custom category
        if (category === 'custom') {
          return customIcons;
        }

        // Handle core builtin categories
        const builtin = getBuiltinIcons().filter((i) => i.category === category);
        const custom = customIcons.filter((i) => i.category === category);
        return [...builtin, ...custom];
      },

      getIcon: (id: string) => {
        if (isBuiltinIcon(id)) {
          return getBuiltinIcon(id);
        }
        return get().customIcons.find((i) => i.id === id);
      },

      loadIconData: async (id: string): Promise<IconData | undefined> => {
        // Get icon metadata - use direct functions for builtin, store state for custom
        let icon: IconMetadata | undefined;
        if (isBuiltinIcon(id)) {
          icon = getBuiltinIcon(id);
          // If not found, the icon may belong to an unloaded lazy category
          if (!icon) {
            await preloadAllLazyCategories();
            icon = getBuiltinIcon(id);
          }
        } else {
          icon = get().customIcons.find((i) => i.id === id);
        }

        if (!icon) return undefined;

        let content: string;

        if (icon.assetPath) {
          // File-based icon — fetch SVG from static assets
          // Check in-memory cache first
          const cached = svgContentCache.get(id);
          if (cached) {
            content = cached;
          } else {
            try {
              const resp = await fetch(icon.assetPath);
              if (!resp.ok) return undefined;
              content = await resp.text();
              svgContentCache.set(id, content);
            } catch {
              return undefined;
            }
          }
        } else if (icon.type === 'builtin' && icon.svgContent) {
          content = icon.svgContent;
        } else if (icon.type === 'custom' && icon.blobId) {
          try {
            const blob = await blobStorage.loadBlob(icon.blobId);
            if (!blob) return undefined;
            content = await blob.text();
          } catch {
            return undefined;
          }
        } else {
          return undefined;
        }

        const viewBox = extractViewBox(content);

        // Only replace currentColor for single-color icons (not multi-color cloud icons)
        const previewContent = icon.multiColor
          ? content
          : content.replace(/currentColor/g, '#666666');

        const result: IconData = {
          ...icon,
          content,
          dataUrl: svgToDataUrl(previewContent),
        };

        if (viewBox) {
          result.viewBox = viewBox;
        }

        return result;
      },

      uploadIcon: async (file: File, name?: string): Promise<IconUploadResult> => {
        if (file.type !== 'image/svg+xml') {
          return { success: false, error: 'File must be an SVG image' };
        }

        try {
          // Read file content
          const content = await file.text();

          // Validate SVG
          const validation = validateSvg(content);
          if (!validation.valid) {
            return { success: false, error: validation.error || 'Invalid SVG' };
          }

          // Sanitize SVG
          const sanitized = sanitizeSvg(content);

          // Store in IndexedDB (saveBlob returns the hash ID)
          const iconName = name || file.name.replace(/\.svg$/i, '');
          const blob = new Blob([sanitized], { type: 'image/svg+xml' });

          const hash = await blobStorage.saveBlob(blob, iconName + '.svg');

          // Check if this icon already exists in our state
          const existingIcon = get().customIcons.find((i) => i.id === hash);
          if (existingIcon) {
            return {
              success: true,
              icon: existingIcon,
            };
          }

          // Create metadata
          const icon: IconMetadata = {
            id: hash,
            name: iconName,
            type: 'custom',
            category: 'custom',
            blobId: hash,
            originalFilename: file.name,
            createdAt: Date.now(),
            usageCount: 1, // saveBlob increments usage count
          };

          // Update state
          set((state) => ({
            customIcons: [...state.customIcons, icon],
          }));

          return { success: true, icon };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to upload icon',
          };
        }
      },

      deleteIcon: async (id: string) => {
        // Can't delete built-in icons
        if (isBuiltinIcon(id)) {
          return false;
        }

        const icon = get().customIcons.find((i) => i.id === id);
        if (!icon) return false;

        try {
          // Delete from blob storage
          if (icon.blobId) {
            await blobStorage.deleteBlob(icon.blobId);
          }

          // Remove from state
          set((state) => ({
            customIcons: state.customIcons.filter((i) => i.id !== id),
          }));

          return true;
        } catch {
          return false;
        }
      },

      renameIcon: (id: string, newName: string) => {
        // Can't rename built-in icons
        if (isBuiltinIcon(id)) return;

        set((state) => ({
          customIcons: state.customIcons.map((icon) =>
            icon.id === id ? { ...icon, name: newName } : icon
          ),
        }));
      },

      selectIcon: (id: string | null) => {
        set({ selectedIconId: id });
      },

      getStats: async () => {
        const { customIcons } = get();

        // Calculate storage used by custom icons
        let customStorageBytes = 0;
        for (const icon of customIcons) {
          if (icon.blobId) {
            try {
              const blob = await blobStorage.loadBlob(icon.blobId);
              if (blob) {
                customStorageBytes += blob.size;
              }
            } catch {
              // Ignore errors
            }
          }
        }

        return {
          builtinCount: BUILTIN_ICON_COUNT,
          customCount: customIcons.length,
          totalCount: BUILTIN_ICON_COUNT + customIcons.length,
          customStorageBytes,
        };
      },

      incrementUsage: (id: string) => {
        if (isBuiltinIcon(id)) return;

        set((state) => ({
          customIcons: state.customIcons.map((icon) =>
            icon.id === id
              ? { ...icon, usageCount: (icon.usageCount || 0) + 1 }
              : icon
          ),
        }));

        // Also increment in blob storage
        const icon = get().customIcons.find((i) => i.id === id);
        if (icon?.blobId) {
          blobStorage.incrementUsageCount(icon.blobId).catch(() => {
            // Ignore errors
          });
        }
      },

      decrementUsage: (id: string) => {
        if (isBuiltinIcon(id)) return;

        set((state) => ({
          customIcons: state.customIcons.map((icon) =>
            icon.id === id
              ? { ...icon, usageCount: Math.max(0, (icon.usageCount || 0) - 1) }
              : icon
          ),
        }));

        // Also decrement in blob storage
        const icon = get().customIcons.find((i) => i.id === id);
        if (icon?.blobId) {
          blobStorage.decrementUsageCount(icon.blobId).catch(() => {
            // Ignore errors
          });
        }
      },

      getUsedIconIds: () => {
        const { customIcons } = get();
        return customIcons
          .filter((icon) => icon.usageCount && icon.usageCount > 0)
          .map((icon) => icon.id);
      },

      clearError: () => {
        set({ error: null });
      },

      loadCategory: async (category: IconCategory): Promise<IconMetadata[]> => {
        // If not a lazy category, return empty
        if (!isLazyCategory(category)) {
          return [];
        }

        // If already loaded, return cached
        if (isCategoryLoaded(category)) {
          return getLazyIconsByCategory(category);
        }

        // If already loading, wait for it
        const state = get();
        if (state.loadingCategories.includes(category)) {
          // Wait for the category to be loaded by checking the cache
          return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
              if (isCategoryLoaded(category)) {
                clearInterval(checkInterval);
                resolve(getLazyIconsByCategory(category));
              }
            }, 50);
          });
        }

        // Start loading
        set((s) => ({
          loadingCategories: [...s.loadingCategories, category],
        }));

        try {
          const icons = await loadLazyCategory(category);
          set((s) => ({
            loadingCategories: s.loadingCategories.filter((c) => c !== category),
            loadedCategories: [...s.loadedCategories, category],
          }));
          return icons;
        } catch (error) {
          set((s) => ({
            loadingCategories: s.loadingCategories.filter((c) => c !== category),
            error: error instanceof Error ? error.message : 'Failed to load category',
          }));
          return [];
        }
      },

      isCategoryLoaded: (category: IconCategory): boolean => {
        if (!isLazyCategory(category)) return true; // Core categories are always loaded
        return isCategoryLoaded(category);
      },

      isCategoryLoading: (category: IconCategory): boolean => {
        return get().loadingCategories.includes(category);
      },

      getCategoryStates: () => {
        return getLazyCategoryStates();
      },
    }),
    {
      name: 'docushark-icon-library',
      partialize: (state) => ({
        customIcons: state.customIcons,
      }),
    }
  )
);

/**
 * Initialize the icon library store.
 * Call this on app startup.
 */
export async function initializeIconLibrary(): Promise<void> {
  await useIconLibraryStore.getState().initialize();
}
