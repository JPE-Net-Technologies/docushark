/**
 * Icon Category Registry
 *
 * Provides lazy loading infrastructure for icon categories.
 * Core categories (arrows, shapes, symbols, tech, general) are loaded eagerly.
 * Extended categories (cloud providers, devops, etc.) are loaded on-demand.
 *
 * Cloud provider icons are loaded from static asset manifests (public/icons/).
 * Dev/language icons are loaded from simple-icons or inline TS modules.
 */

import type { IconCategory, IconMetadata } from '../IconTypes';

/**
 * Built-in icon definition (internal format for inline SVG icons).
 */
export interface BuiltinIcon {
  name: string;
  category: IconCategory;
  svg: string;
}

/**
 * Convert built-in icon to IconMetadata.
 */
export function toMetadata(icon: BuiltinIcon): IconMetadata {
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
 * Manifest entry as stored in the JSON manifest files.
 */
interface ManifestEntry {
  id: string;
  name: string;
  file: string;
}

/**
 * Load a cloud provider icon manifest and convert to IconMetadata[].
 */
async function loadCloudManifest(
  manifestUrl: string,
  category: IconCategory,
  assetDir: string
): Promise<IconMetadata[]> {
  const resp = await fetch(manifestUrl);
  if (!resp.ok) throw new Error(`Failed to load manifest: ${manifestUrl}`);
  const entries: ManifestEntry[] = await resp.json();

  return entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    type: 'builtin' as const,
    category,
    assetPath: `${assetDir}/${entry.file}`,
    multiColor: true,
  }));
}

/**
 * Category loader definition.
 * Returns IconMetadata[] directly (supports both inline SVG and asset-based icons).
 */
export interface CategoryLoader {
  category: IconCategory;
  load: () => Promise<IconMetadata[]>;
}

/**
 * Registry of lazy-loadable icon categories.
 */
export const CATEGORY_LOADERS: CategoryLoader[] = [
  // Cloud providers — loaded from static asset manifests
  {
    category: 'cloud-aws',
    load: () => loadCloudManifest('/icons/aws-manifest.json', 'cloud-aws', '/icons/aws'),
  },
  {
    category: 'cloud-azure',
    load: () => loadCloudManifest('/icons/azure-manifest.json', 'cloud-azure', '/icons/azure'),
  },
  {
    category: 'cloud-gcp',
    load: () => loadCloudManifest('/icons/gcp-manifest.json', 'cloud-gcp', '/icons/gcp'),
  },
  // DevOps & Infrastructure
  {
    category: 'devops',
    load: () => import('./devopsIcons').then((m) => m.default.map(toMetadata)),
  },
  // Databases
  {
    category: 'databases',
    load: () => import('./databaseIcons').then((m) => m.default.map(toMetadata)),
  },
  // Programming Languages
  {
    category: 'languages',
    load: () => import('./languageIcons').then((m) => m.default.map(toMetadata)),
  },
  // Frameworks & Libraries
  {
    category: 'frameworks',
    load: () => import('./frameworkIcons').then((m) => m.default.map(toMetadata)),
  },
];

/**
 * Get the loader for a specific category.
 */
export function getCategoryLoader(category: IconCategory): CategoryLoader | undefined {
  return CATEGORY_LOADERS.find((l) => l.category === category);
}

/**
 * Check if a category has a lazy loader.
 */
export function hasLazyLoader(category: IconCategory): boolean {
  return CATEGORY_LOADERS.some((l) => l.category === category);
}
