import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCatalog, CATALOG_PATH, CLOUD_PREFIX, type IconCatalog } from './gen-icon-catalog';

/**
 * Drift guard (JP-342, aligned with the JP-326 cross-boundary safety net): the
 * committed `relay/src/mcp/icons/catalog.json` the relay embeds must match a
 * fresh generation from the client icon sources. If this fails, an icon source
 * changed without regenerating — run `bun run scripts/gen-icon-catalog.ts`.
 *
 * The cloud-provider manifests are vendored + gitignored, so they're absent in
 * CI. We rebuild with `allowMissingManifests` and compare only the categories
 * the fresh build could actually produce — which still catches drift in the
 * in-repo TS icon sources (builtins + devops/databases/languages/frameworks),
 * and compares the cloud sets too whenever the assets are present (locally).
 */
describe('icon catalog', () => {
  it('committed relay catalog is in sync with the rebuildable client icon sources', async () => {
    const fresh = await buildCatalog({ allowMissingManifests: true });
    const committed = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as IconCatalog;

    // Restrict the committed catalog to the categories this build rebuilt
    // (cloud is skipped when its manifests are absent in CI).
    const rebuiltCategories = new Set(fresh.icons.map((i) => i.category));
    const committedSubset = committed.icons.filter((i) => rebuiltCategories.has(i.category));

    expect(fresh.icons).toEqual(committedSubset);

    // Sanity: the committed catalog is the full set (cloud always present in it).
    expect(committed.count).toBe(committed.icons.length);
    expect(committed.count).toBeGreaterThanOrEqual(fresh.count);
  });

  it('rebuilds a non-trivial set of in-repo icons', async () => {
    const { icons } = await buildCatalog({ allowMissingManifests: true });
    expect(icons.length).toBeGreaterThan(100);

    const categories = new Set(icons.map((i) => i.category));
    expect(categories.has('arrows')).toBe(true); // eager builtin
    expect(categories.has('devops')).toBe(true); // lazy TS module

    // Every entry is well-formed; cloud entries appear only when vendored.
    for (const i of icons) {
      expect(i.id.startsWith('builtin:')).toBe(true);
      expect(i.name.length).toBeGreaterThan(0);
      expect(i.category.length).toBeGreaterThan(0);
    }

    // The committed (full) catalog always carries the cloud sets.
    const committed = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as IconCatalog;
    expect(committed.icons.some((i) => i.category.startsWith(CLOUD_PREFIX))).toBe(true);
  });
});
