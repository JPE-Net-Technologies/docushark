/**
 * Shared icon resolver for import adapters (JP-86 follow-up).
 *
 * Source formats name icon-bearing stencils by a provider-qualified leaf
 * (drawio `mxgraph.aws4.lambda`, a future Mermaid `::icon`). To realise the
 * "icon-in-container" mapping (see *Shapes Design - Adapters* §4) we match that
 * leaf against the icon catalog and, on a hit, set `iconId` on a box shape
 * instead of dropping the stencil to a plain labelled box.
 *
 * `matchIconId` is the pure, reusable core — token-overlap over an icon list,
 * unit-testable against the real bundled manifests. Catalog *loading* (which
 * category, the async `loadCategory` fetch) stays in the adapter glue, because
 * the matcher must work the same whether the icons came from the store, a test
 * fixture, or a future Iconify provider.
 */

import type { IconMetadata } from '../../storage/IconTypes';

/**
 * Provider / filler words that carry no discriminating signal — dropping them
 * lets a source leaf like `lambda` match the catalog name "AWS Lambda".
 */
const NOISE = new Set([
  'aws', 'amazon', 'azure', 'microsoft', 'mscae', 'gcp', 'google', 'cloud',
  'mxgraph', 'resourceicon', 'resicon', 'service', 'services', 'icon', 'icons',
  'the', 'of', 'for', 'and', 'a', 'an',
]);

/** Lowercase → discriminating alphanumeric tokens (noise + empties dropped). */
export function normalizeTokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (t) =>
        t.length > 0 &&
        !NOISE.has(t) &&
        // drawio provider buckets carry a version digit (`aws4`, `gcp2`,
        // `azure3`) — drop those without touching real tokens like `ec2`/`s3`.
        !/^(aws|gcp|azure)\d+$/.test(t)
    );
}

/** The discriminating part of a builtin id, e.g. `builtin:aws-amazon-s3` → `amazon-s3`. */
function idLeaf(id: string): string {
  return id.startsWith('builtin:') ? id.slice('builtin:'.length).replace(/^[a-z0-9]+-/, '') : id;
}

/**
 * Best icon id whose name/id covers **every** token of `query`, or null.
 *
 * Full-coverage is the guard against false positives (a one-token overlap
 * shouldn't win). Among full-coverage candidates the most *specific* one wins —
 * the smallest token set — so "compute engine" prefers "Compute Engine" over
 * "Migrate For Compute Engine".
 */
export function matchIconId(query: string, icons: IconMetadata[]): string | null {
  const q = normalizeTokens(query);
  if (q.length === 0) return null;

  let bestId: string | null = null;
  let bestSize = Infinity;

  for (const icon of icons) {
    const tokens = new Set([...normalizeTokens(icon.name), ...normalizeTokens(idLeaf(icon.id))]);
    if (!q.every((t) => tokens.has(t))) continue; // require full coverage
    if (tokens.size < bestSize) {
      bestSize = tokens.size;
      bestId = icon.id;
    }
  }
  return bestId;
}

/** Map a provider token (from a stencil prefix) to its catalog category. */
export function providerCategory(provider: string): IconMetadata['category'] | null {
  const p = provider.toLowerCase();
  if (p.startsWith('aws')) return 'cloud-aws';
  if (p.startsWith('azure') || p === 'mscae') return 'cloud-azure';
  if (p.startsWith('gcp')) return 'cloud-gcp';
  return null;
}
