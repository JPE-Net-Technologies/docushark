/**
 * Style-adapter registry (JP-33).
 *
 * A shape's "adapter" is emergent: it is exactly the subset of {@link STYLE_FACETS}
 * whose {@link StyleFacet.appliesTo} is true for the shape type. There are no
 * hand-written per-type adapter objects to keep in sync.
 *
 * The result is intentionally not cached: capability sources (shape metadata,
 * the shape-library store) can register after the first call, and filtering a
 * handful of cheap predicates per user-triggered apply is negligible.
 */

import type { StyleFacet } from './types';
import { STYLE_FACETS } from './facets';

/**
 * Resolve the ordered list of facets that apply to a shape type.
 *
 * Unknown types fall through to just the universal facet (fill/stroke/
 * strokeWidth/opacity), since every non-universal facet returns `false` for an
 * unrecognized type — so there is no separate "default adapter" to maintain.
 */
export function resolveStyleAdapter(type: string): readonly StyleFacet[] {
  return STYLE_FACETS.filter((facet) => facet.appliesTo(type));
}
