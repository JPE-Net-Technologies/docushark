/**
 * Generate the MCP icon catalog (JP-342).
 *
 * The relay's MCP `list_icons` tool needs to know which icon IDs exist, but the
 * icon library is client-side (TS modules + cloud manifests). This collects icon
 * *metadata only* (id, name, category — no SVG; the relay never renders) into a
 * single JSON that the relay embeds via include_str!.
 *
 * Sources:
 *   - eager builtins      → src/storage/builtinIcons.ts (getBuiltinIcons)
 *   - lazy TS categories  → CATEGORY_LOADERS (devops/databases/languages/frameworks)
 *   - cloud providers     → public/icons/{aws,azure,gcp}-manifest.json
 *
 * Run: `bun run scripts/gen-icon-catalog.ts` (also wired as a package script).
 * Keep the committed catalog in sync — CI / the relay drift test checks it.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBuiltinIcons } from '../src/storage/builtinIcons';
import { CATEGORY_LOADERS } from '../src/storage/icons/index';

interface CatalogIcon {
  id: string;
  name: string;
  category: string;
}

/** Category prefixes whose source manifests are vendored (gitignored). */
export const CLOUD_PREFIX = 'cloud-';

const CLOUD_MANIFESTS: Array<{ category: string; file: string }> = [
  { category: 'cloud-aws', file: 'aws-manifest.json' },
  { category: 'cloud-azure', file: 'azure-manifest.json' },
  { category: 'cloud-gcp', file: 'gcp-manifest.json' },
];

// Anchor to the package root (cwd for `bun run` and vitest) rather than
// import.meta.url, which vitest rewrites.
function rel(path: string): string {
  return join(process.cwd(), path);
}

export interface IconCatalog {
  generator: string;
  count: number;
  icons: CatalogIcon[];
}

async function collect(allowMissingManifests: boolean): Promise<CatalogIcon[]> {
  const out: CatalogIcon[] = [];

  // Eager core builtins (arrows, shapes, symbols, tech, general).
  for (const m of getBuiltinIcons()) {
    out.push({ id: m.id, name: m.name, category: m.category });
  }

  // Lazy TS categories — reuse the app's own loaders. Cloud loaders fetch over
  // HTTP (no server here), so skip them and read the manifests below instead.
  for (const loader of CATEGORY_LOADERS) {
    if (loader.category.startsWith(CLOUD_PREFIX)) continue;
    const icons = await loader.load();
    for (const m of icons) out.push({ id: m.id, name: m.name, category: m.category });
  }

  // Cloud-provider icons straight from the static manifests. These are vendored
  // and gitignored (large provider asset sets), so they're absent in CI — when
  // `allowMissingManifests` (the drift test), skip a missing one and let the
  // test compare only the categories it could rebuild. The CLI writer requires
  // them so a stray run never silently drops the cloud icons.
  for (const { category, file } of CLOUD_MANIFESTS) {
    const path = rel(`public/icons/${file}`);
    if (!existsSync(path)) {
      if (allowMissingManifests) continue;
      throw new Error(
        `Missing icon manifest ${path}. The cloud icon assets are vendored ` +
          `(gitignored); install them before regenerating the catalog.`
      );
    }
    const entries = JSON.parse(readFileSync(path, 'utf8')) as Array<{
      id: string;
      name: string;
      file: string;
    }>;
    for (const e of entries) out.push({ id: e.id, name: e.name, category });
  }

  return out;
}

/**
 * Build the catalog in memory (deduped + sorted). Pure — no disk writes, so the
 * drift test can compare it against the committed artifact.
 *
 * `allowMissingManifests` (default false) lets the drift test rebuild in CI
 * where the vendored cloud manifests are absent; the writer leaves it false so a
 * regeneration without the assets fails loudly instead of dropping cloud icons.
 */
export async function buildCatalog(
  { allowMissingManifests = false }: { allowMissingManifests?: boolean } = {}
): Promise<IconCatalog> {
  const collected = await collect(allowMissingManifests);

  // Dedupe by id (first wins) and sort for a stable, diff-friendly artifact.
  const byId = new Map<string, CatalogIcon>();
  for (const icon of collected) {
    if (!byId.has(icon.id)) byId.set(icon.id, icon);
  }
  const icons = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));

  return {
    // Regenerate with: bun run scripts/gen-icon-catalog.ts
    generator: 'scripts/gen-icon-catalog.ts',
    count: icons.length,
    icons,
  };
}

/** Absolute path of the committed catalog the relay embeds. */
export const CATALOG_PATH = rel('relay/src/mcp/icons/catalog.json');

// CLI entry — only writes when run directly (`bun run scripts/...`), so an
// import (e.g. the drift test) is side-effect free.
if (import.meta.main) {
  const catalog = await buildCatalog();
  mkdirSync(rel('relay/src/mcp/icons'), { recursive: true });
  writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 0)}\n`);
  console.log(`Wrote ${catalog.count} icons → ${CATALOG_PATH}`);
}
