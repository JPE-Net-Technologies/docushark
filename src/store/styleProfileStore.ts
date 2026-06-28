import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { nanoid } from 'nanoid';
import type { BaseShape } from '../shapes/Shape';
import { resolveStyleAdapter } from './styleProfile';
import type {
  StyleProfileProperties,
  ShapeStyleUpdate,
  ResolvedExtractOptions,
} from './styleProfile';

// The profile value types now live in `./styleProfile/types` (the dependency
// root of the adapter layer). Re-export them here so existing import paths
// (`./styleProfileStore`) keep working unchanged.
export type { IconPosition, StyleProfileProperties } from './styleProfile';

/**
 * A saved style profile.
 */
export interface StyleProfile {
  id: string;
  name: string;
  properties: StyleProfileProperties;
  createdAt: number;
  /** Whether this profile is marked as a favorite */
  favorite: boolean;

  // Ownership fields (Phase 14.1 - Team mode)
  /** User ID who owns this profile (null = SYSTEM owned, available to all) */
  ownerId?: string | null;
  /** Whether the profile is locked by the owner (only owner can modify/delete) */
  ownerLocked?: boolean;
}

/**
 * Style profile store state.
 */
interface StyleProfileState {
  profiles: StyleProfile[];
}

/**
 * Style profile store actions.
 */
interface StyleProfileActions {
  /** Add a new profile */
  addProfile: (name: string, properties: StyleProfileProperties) => StyleProfile;
  /** Update an existing profile */
  updateProfile: (id: string, updates: Partial<Omit<StyleProfile, 'id' | 'createdAt'>>) => void;
  /** Delete a profile */
  deleteProfile: (id: string) => void;
  /** Rename a profile */
  renameProfile: (id: string, name: string) => void;
  /** Toggle favorite status */
  toggleFavorite: (id: string) => void;
  /** Get a profile by ID */
  getProfile: (id: string) => StyleProfile | undefined;
  /** Clear all profiles */
  clearProfiles: () => void;
  /** Get profiles sorted with favorites first */
  getSortedProfiles: () => StyleProfile[];
}

/**
 * Default built-in profiles.
 */
const DEFAULT_PROFILES: StyleProfile[] = [
  {
    id: 'default-blue',
    name: 'Default Blue',
    properties: {
      fill: '#4a90d9',
      stroke: '#2c5282',
      strokeWidth: 2,
      opacity: 1,
      cornerRadius: 0,
    },
    createdAt: 0,
    favorite: false,
  },
  {
    id: 'default-green',
    name: 'Fresh Green',
    properties: {
      fill: '#48bb78',
      stroke: '#276749',
      strokeWidth: 2,
      opacity: 1,
      cornerRadius: 8,
    },
    createdAt: 0,
    favorite: false,
  },
  {
    id: 'default-orange',
    name: 'Warm Orange',
    properties: {
      fill: '#ed8936',
      stroke: '#c05621',
      strokeWidth: 2,
      opacity: 1,
      cornerRadius: 4,
    },
    createdAt: 0,
    favorite: false,
  },
  {
    id: 'default-outline',
    name: 'Outline Only',
    properties: {
      fill: null,
      stroke: '#2c5282',
      strokeWidth: 2,
      opacity: 1,
    },
    createdAt: 0,
    favorite: false,
  },
  {
    id: 'default-subtle',
    name: 'Subtle Gray',
    properties: {
      fill: '#e2e8f0',
      stroke: '#a0aec0',
      strokeWidth: 1,
      opacity: 0.9,
      cornerRadius: 4,
    },
    createdAt: 0,
    favorite: false,
  },
];

/**
 * Style profile store for managing reusable style presets.
 * Persisted to localStorage.
 */
export const useStyleProfileStore = create<StyleProfileState & StyleProfileActions>()(
  persist(
    (set, get) => ({
      profiles: DEFAULT_PROFILES,

      addProfile: (name: string, properties: StyleProfileProperties) => {
        const profile: StyleProfile = {
          id: nanoid(),
          name,
          properties,
          createdAt: Date.now(),
          favorite: false,
        };

        set((state) => ({
          profiles: [...state.profiles, profile],
        }));

        return profile;
      },

      updateProfile: (id: string, updates: Partial<Omit<StyleProfile, 'id' | 'createdAt'>>) => {
        set((state) => ({
          profiles: state.profiles.map((p) =>
            p.id === id ? { ...p, ...updates } : p
          ),
        }));
      },

      deleteProfile: (id: string) => {
        // Don't allow deleting default profiles
        if (id.startsWith('default-')) return;

        set((state) => ({
          profiles: state.profiles.filter((p) => p.id !== id),
        }));
      },

      renameProfile: (id: string, name: string) => {
        // Don't allow renaming default profiles
        if (id.startsWith('default-')) return;

        set((state) => ({
          profiles: state.profiles.map((p) =>
            p.id === id ? { ...p, name } : p
          ),
        }));
      },

      toggleFavorite: (id: string) => {
        set((state) => ({
          profiles: state.profiles.map((p) =>
            p.id === id ? { ...p, favorite: !p.favorite } : p
          ),
        }));
      },

      getProfile: (id: string) => {
        return get().profiles.find((p) => p.id === id);
      },

      clearProfiles: () => {
        // Reset to default profiles only
        set({ profiles: DEFAULT_PROFILES });
      },

      getSortedProfiles: () => {
        const profiles = get().profiles;
        // Sort: favorites first (alphabetically), then non-favorites (alphabetically)
        return [...profiles].sort((a, b) => {
          if (a.favorite && !b.favorite) return -1;
          if (!a.favorite && b.favorite) return 1;
          return a.name.localeCompare(b.name);
        });
      },
    }),
    {
      name: 'docushark-style-profiles',
      version: 1,
    }
  )
);

/**
 * Options for extracting style properties from a shape.
 */
export interface ExtractStyleOptions {
  /** Include icon properties (iconId, iconSize, iconPadding, iconColor, iconPosition) */
  includeIconStyle?: boolean;
  /** Include label properties (labelFontSize, labelColor) */
  includeLabelStyle?: boolean;
}

/**
 * Default options for extractStyleFromShape.
 */
const DEFAULT_EXTRACT_OPTIONS: ExtractStyleOptions = {
  includeIconStyle: true,
  includeLabelStyle: true,
};

/**
 * Extract style properties from a shape for creating a profile.
 *
 * Dispatches to the per-shape adapter (the facets that apply to `shape.type`):
 * universal fill/stroke/strokeWidth/opacity are always present, and each facet
 * layers on the type-specific fields it owns. See `./styleProfile`.
 *
 * @param shape - The shape to extract styles from
 * @param options - Options for what to include (default: include all)
 */
export function extractStyleFromShape(shape: BaseShape, options?: ExtractStyleOptions): StyleProfileProperties {
  const opts: ResolvedExtractOptions = {
    includeIconStyle: options?.includeIconStyle ?? DEFAULT_EXTRACT_OPTIONS.includeIconStyle ?? true,
    includeLabelStyle: options?.includeLabelStyle ?? DEFAULT_EXTRACT_OPTIONS.includeLabelStyle ?? true,
  };

  // Seed the four universal (required) fields so the return type is satisfied
  // even before facets run; the universal facet re-affirms the same values.
  const properties: StyleProfileProperties = {
    fill: shape.fill ?? null,
    stroke: shape.stroke ?? null,
    strokeWidth: shape.strokeWidth ?? 2,
    opacity: shape.opacity ?? 1,
  };

  for (const facet of resolveStyleAdapter(shape.type)) {
    Object.assign(properties, facet.extract(shape, opts));
  }

  return properties;
}

/**
 * Translate a profile into the concrete field updates to apply to a shape.
 *
 * Dispatches to the per-shape adapter. The result is a `Partial<Shape>`-shaped
 * update (it includes an already-merged `customProperties` object for ERD
 * entities), so callers hand it straight to `updateShape(id, updates)` with no
 * shape-type special-casing.
 *
 * This is also the primitive a future "Dynamic Style Profiles" `styleProfileRef`
 * would call to resolve/merge a referenced profile onto a shape.
 *
 * Note: the second parameter is the **shape** (not just its type) because the
 * ERD facet needs the existing `customProperties` to merge rather than clobber.
 */
export function getProfileUpdates(profile: StyleProfile, shape: BaseShape): ShapeStyleUpdate {
  const updates: ShapeStyleUpdate = {};
  for (const facet of resolveStyleAdapter(shape.type)) {
    Object.assign(updates, facet.apply(profile.properties, shape));
  }
  return updates;
}

/**
 * Get human-readable list of properties that apply to a shape type.
 * Useful for UI to show what a profile will change.
 */
export function getApplicablePropertyNames(shapeType: string): string[] {
  return resolveStyleAdapter(shapeType).flatMap((facet) => [...facet.names]);
}
