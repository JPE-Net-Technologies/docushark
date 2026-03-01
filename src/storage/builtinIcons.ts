/**
 * Built-in SVG icons for the icon library.
 *
 * Icons use 24x24 viewBox and currentColor for fill/stroke
 * to allow dynamic coloring when rendered.
 *
 * Core categories (arrows, shapes, symbols, tech, general) are loaded eagerly.
 * Extended categories (cloud providers, devops, etc.) are loaded on-demand.
 */

import type { IconMetadata, IconCategory } from './IconTypes';
import { LAZY_ICON_CATEGORIES } from './IconTypes';
import { CATEGORY_LOADERS, type BuiltinIcon } from './icons/index';

/**
 * Cache for lazily loaded icon categories.
 */
const lazyIconCache = new Map<IconCategory, IconMetadata[]>();

/**
 * Loading state for categories.
 */
const loadingCategories = new Map<IconCategory, Promise<IconMetadata[]>>();

/**
 * Arrow icons.
 */
const arrowIcons: BuiltinIcon[] = [
  {
    name: 'Arrow Right',
    category: 'arrows',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>`,
  },
  {
    name: 'Arrow Left',
    category: 'arrows',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>`,
  },
  {
    name: 'Arrow Up',
    category: 'arrows',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>`,
  },
  {
    name: 'Arrow Down',
    category: 'arrows',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>`,
  },
  {
    name: 'Arrow Bidirectional',
    category: 'arrows',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>`,
  },
  {
    name: 'Arrow Curved',
    category: 'arrows',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3 8c4-4 9-4 13-2s6 6 4 12"/></svg>`,
  },
];

/**
 * Shape icons.
 */
const shapeIcons: BuiltinIcon[] = [
  {
    name: 'Star',
    category: 'shapes',
    svg: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`,
  },
  {
    name: 'Heart',
    category: 'shapes',
    svg: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`,
  },
  {
    name: 'Checkmark',
    category: 'shapes',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  },
  {
    name: 'X Mark',
    category: 'shapes',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
  },
  {
    name: 'Plus',
    category: 'shapes',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
  },
  {
    name: 'Circle',
    category: 'shapes',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>`,
  },
  {
    name: 'Diamond',
    category: 'shapes',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 12l10 10 10-10L12 2z"/></svg>`,
  },
];

/**
 * Symbol icons.
 */
const symbolIcons: BuiltinIcon[] = [
  {
    name: 'Warning',
    category: 'symbols',
    svg: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`,
  },
  {
    name: 'Info',
    category: 'symbols',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`,
  },
  {
    name: 'Question',
    category: 'symbols',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
  },
  {
    name: 'Lock',
    category: 'symbols',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  },
  {
    name: 'Gear',
    category: 'symbols',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
  },
  {
    name: 'Flag',
    category: 'symbols',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/></svg>`,
  },
  {
    name: 'Lightning',
    category: 'symbols',
    svg: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>`,
  },
];

/**
 * Tech/diagram icons.
 */
const techIcons: BuiltinIcon[] = [
  {
    name: 'Database',
    category: 'tech',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
  },
  {
    name: 'Server',
    category: 'tech',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg>`,
  },
  {
    name: 'Cloud',
    category: 'tech',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`,
  },
  {
    name: 'File',
    category: 'tech',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`,
  },
  {
    name: 'Folder',
    category: 'tech',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  },
  {
    name: 'Code',
    category: 'tech',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  },
  {
    name: 'Terminal',
    category: 'tech',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>`,
  },
  {
    name: 'API',
    category: 'tech',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  },
  {
    name: 'User',
    category: 'tech',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  },
  {
    name: 'Users',
    category: 'tech',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  },
];

/**
 * General purpose icons.
 */
const generalIcons: BuiltinIcon[] = [
  {
    name: 'Home',
    category: 'general',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
  },
  {
    name: 'Mail',
    category: 'general',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`,
  },
  {
    name: 'Clock',
    category: 'general',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  },
  {
    name: 'Calendar',
    category: 'general',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>`,
  },
  {
    name: 'Search',
    category: 'general',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
  },
];

/**
 * All built-in icons combined.
 */
const allBuiltinIcons: BuiltinIcon[] = [
  ...arrowIcons,
  ...shapeIcons,
  ...symbolIcons,
  ...techIcons,
  ...generalIcons,
];

/**
 * Convert built-in icon to IconMetadata (local helper for core icons).
 */
function toMetadataLocal(icon: { name: string; category: IconCategory; svg: string }): IconMetadata {
  const id = `builtin:${icon.name.toLowerCase().replace(/\s+/g, '-')}`;
  return {
    id,
    name: icon.name,
    type: 'builtin',
    category: icon.category,
    svgContent: icon.svg,
  };
}

/**
 * Get all core built-in icons as IconMetadata.
 * Does not include lazy-loaded categories.
 */
export function getBuiltinIcons(): IconMetadata[] {
  return allBuiltinIcons.map(toMetadataLocal);
}

/**
 * Get core built-in icons by category.
 * For lazy categories, use loadLazyCategory instead.
 */
export function getBuiltinIconsByCategory(category: IconCategory): IconMetadata[] {
  // Check if this is a lazy category
  if (isLazyCategory(category)) {
    return getLazyIconsByCategory(category);
  }
  return allBuiltinIcons
    .filter((icon) => icon.category === category)
    .map(toMetadataLocal);
}

/**
 * Get a specific built-in icon by ID.
 * Searches both core icons and lazy-loaded icons.
 */
export function getBuiltinIcon(id: string): IconMetadata | undefined {
  if (!id.startsWith('builtin:')) return undefined;

  const name = id.slice(8).replace(/-/g, ' ').toLowerCase();
  const icon = allBuiltinIcons.find(
    (i) => i.name.toLowerCase() === name
  );

  if (icon) return toMetadataLocal(icon);

  // Also search lazy-loaded icons
  return getLazyIcon(id);
}

/**
 * Check if an icon ID is a built-in icon.
 */
export function isBuiltinIcon(id: string): boolean {
  return id.startsWith('builtin:');
}

/**
 * Get all icon categories with counts.
 * Includes lazy categories (with count 0 if not loaded).
 */
export function getIconCategories(): Array<{ category: IconCategory; count: number; lazy: boolean }> {
  const counts = new Map<IconCategory, number>();

  // Count core icons
  for (const icon of allBuiltinIcons) {
    counts.set(icon.category, (counts.get(icon.category) || 0) + 1);
  }

  // Build result with core categories
  const result: Array<{ category: IconCategory; count: number; lazy: boolean }> = Array.from(
    counts.entries()
  ).map(([category, count]) => ({
    category,
    count,
    lazy: false,
  }));

  // Add lazy categories
  for (const category of LAZY_ICON_CATEGORIES) {
    const cached = lazyIconCache.get(category);
    result.push({
      category,
      count: cached?.length || 0,
      lazy: true,
    });
  }

  return result;
}

/**
 * Total count of core built-in icons (eagerly loaded).
 */
export const BUILTIN_ICON_COUNT = allBuiltinIcons.length;

/**
 * Load icons for a lazy-loadable category.
 * Returns cached icons if already loaded.
 */
export async function loadLazyCategory(category: IconCategory): Promise<IconMetadata[]> {
  // Check if already cached
  const cached = lazyIconCache.get(category);
  if (cached) return cached;

  // Check if already loading
  const loading = loadingCategories.get(category);
  if (loading) return loading;

  // Find the loader
  const loader = CATEGORY_LOADERS.find((l) => l.category === category);
  if (!loader) return [];

  // Start loading — loaders now return IconMetadata[] directly
  const loadPromise = loader.load().then((metadata) => {
    lazyIconCache.set(category, metadata);
    loadingCategories.delete(category);
    return metadata;
  });

  loadingCategories.set(category, loadPromise);
  return loadPromise;
}

/**
 * Check if a category is lazily loaded.
 */
export function isLazyCategory(category: IconCategory): boolean {
  return LAZY_ICON_CATEGORIES.includes(category);
}

/**
 * Check if a lazy category has been loaded.
 */
export function isCategoryLoaded(category: IconCategory): boolean {
  return lazyIconCache.has(category);
}

/**
 * Get all loaded lazy icons (for search across all categories).
 */
export function getLoadedLazyIcons(): IconMetadata[] {
  return Array.from(lazyIconCache.values()).flat();
}

/**
 * Get icons from a lazy category (returns empty if not loaded).
 */
export function getLazyIconsByCategory(category: IconCategory): IconMetadata[] {
  return lazyIconCache.get(category) || [];
}

/**
 * Preload all lazy categories in the background.
 */
export async function preloadAllLazyCategories(): Promise<void> {
  await Promise.all(LAZY_ICON_CATEGORIES.map(loadLazyCategory));
}

/**
 * Get a lazy-loaded icon by ID.
 */
export function getLazyIcon(id: string): IconMetadata | undefined {
  if (!id.startsWith('builtin:')) return undefined;

  for (const icons of lazyIconCache.values()) {
    const icon = icons.find((i) => i.id === id);
    if (icon) return icon;
  }

  return undefined;
}

/**
 * Get lazy icon categories with their loading state.
 */
export function getLazyCategoryStates(): Array<{
  category: IconCategory;
  loaded: boolean;
  loading: boolean;
  count: number;
}> {
  return LAZY_ICON_CATEGORIES.map((category) => ({
    category,
    loaded: lazyIconCache.has(category),
    loading: loadingCategories.has(category),
    count: lazyIconCache.get(category)?.length || 0,
  }));
}
