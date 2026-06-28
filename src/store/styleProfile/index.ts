/**
 * Per-shape style-profile adapter layer (JP-33).
 *
 * Translates a flat style profile to/from concrete shape fields via composable
 * facets resolved per shape type. See {@link resolveStyleAdapter} and the
 * {@link StyleFacet} contract.
 */

export type {
  IconPosition,
  StyleProfileProperties,
  ShapeStyleUpdate,
  ResolvedExtractOptions,
  StyleFacet,
  ErdProfileKey,
} from './types';
export { resolveStyleAdapter } from './registry';
export { STYLE_FACETS } from './facets';
export { shapeSupportsLabel, shapeSupportsIcon } from './capabilities';
