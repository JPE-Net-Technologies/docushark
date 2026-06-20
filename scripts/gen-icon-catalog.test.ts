import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCatalog, CATALOG_PATH } from './gen-icon-catalog';

/**
 * Drift guard (JP-342, aligned with the JP-326 cross-boundary safety net): the
 * committed `relay/src/mcp/icons/catalog.json` the relay embeds must match a
 * fresh generation from the client icon sources. If this fails, an icon source
 * changed without regenerating — run `bun run scripts/gen-icon-catalog.ts`.
 */
describe('icon catalog', () => {
  it('committed relay catalog is in sync with the client icon sources', async () => {
    const fresh = await buildCatalog();
    const committed = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as typeof fresh;

    expect(committed.count).toBe(fresh.count);
    expect(committed.icons).toEqual(fresh.icons);
  });

  it('generates a non-trivial catalog with cloud + builtin icons', async () => {
    const { icons } = await buildCatalog();
    expect(icons.length).toBeGreaterThan(500);
    const categories = new Set(icons.map((i) => i.category));
    expect(categories.has('cloud-aws')).toBe(true);
    expect(categories.has('arrows')).toBe(true);
    // Every entry is well-formed.
    for (const i of icons) {
      expect(i.id.startsWith('builtin:')).toBe(true);
      expect(i.name.length).toBeGreaterThan(0);
      expect(i.category.length).toBeGreaterThan(0);
    }
  });
});
