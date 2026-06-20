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

/** Base href the app is served from (`/` in dev, e.g. `/app/` under a subpath). */
function assetBase(): string {
  return import.meta.env.BASE_URL ?? '/';
}

/**
 * Load a cloud provider icon manifest and convert to IconMetadata[].
 *
 * `manifestPath`/`assetDir` are relative to the app base href (no leading
 * slash) — they're prefixed with {@link assetBase} so the fetch works under a
 * non-root deploy path. A 404 / SPA-shell / service-worker navigation fallback
 * returns HTML, not JSON; we detect that and throw a precise error rather than
 * letting `JSON.parse` surface the opaque "Unexpected token '<'" message.
 */
async function loadCloudManifest(
  manifestPath: string,
  category: IconCategory,
  assetDir: string
): Promise<IconMetadata[]> {
  const base = assetBase();
  const manifestUrl = `${base}${manifestPath}`;
  const resp = await fetch(manifestUrl);
  if (!resp.ok) {
    throw new Error(`Failed to load icon manifest (${resp.status}): ${manifestUrl}`);
  }

  const contentType = resp.headers.get('content-type') ?? '';
  const text = await resp.text();
  if (contentType.includes('text/html') || text.trimStart().startsWith('<')) {
    throw new Error(
      `Icon manifest at ${manifestUrl} returned HTML, not JSON — likely a 404 / ` +
        `SPA-shell or service-worker navigation fallback. Check the asset is ` +
        `deployed and not intercepted.`
    );
  }

  let entries: ManifestEntry[];
  try {
    entries = JSON.parse(text) as ManifestEntry[];
  } catch {
    throw new Error(`Icon manifest at ${manifestUrl} is not valid JSON.`);
  }

  return entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    type: 'builtin' as const,
    category,
    assetPath: `${base}${assetDir}/${entry.file}`,
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
  // Cloud providers — loaded from static asset manifests (paths relative to
  // the app base href; loadCloudManifest prefixes import.meta.env.BASE_URL).
  {
    category: 'cloud-aws',
    load: () => loadCloudManifest('icons/aws-manifest.json', 'cloud-aws', 'icons/aws'),
  },
  {
    category: 'cloud-azure',
    load: () => loadCloudManifest('icons/azure-manifest.json', 'cloud-azure', 'icons/azure'),
  },
  {
    category: 'cloud-gcp',
    load: () => loadCloudManifest('icons/gcp-manifest.json', 'cloud-gcp', 'icons/gcp'),
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
