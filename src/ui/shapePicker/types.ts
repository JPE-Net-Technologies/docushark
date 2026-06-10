/**
 * Shared types for the unified ShapePicker.
 *
 * A `PickerEntry` is the normalized, data-only shape that the picker's grid,
 * search, and keyboard layer operate on — it abstracts over the two underlying
 * sources (built-in library shapes registered in the ShapeRegistry, and
 * user-authored custom-library items stored in IndexedDB). Keeping entries pure
 * data (no functions, no React) lets the filter/recents logic be unit-tested in
 * isolation; the component owns the insert/drag side effects keyed off `kind`.
 */

/** Which source an entry came from — determines how it is inserted. */
export type PickerEntryKind = 'builtin' | 'custom';

/** A pseudo-category used for the always-present "All" pill. */
export const ALL_CATEGORY = 'all' as const;

/** Category identifier used for grouping/filtering within the picker. */
export type PickerCategory = string;

/**
 * Normalized, serializable description of one insertable shape.
 */
export interface PickerEntry {
  /** Stable unique key. builtin → shape type; custom → `custom-shape:<itemId>`. */
  id: string;

  /** Human-readable display name. */
  name: string;

  /** Category key for grouping/filtering (e.g. 'flowchart', 'custom'). */
  category: PickerCategory;

  /** Human-readable category label for display + search. */
  categoryLabel: string;

  /** Lowercased search tokens (name words + category + description + synonyms). */
  keywords: string[];

  /** Source kind — selects the insert/drag behavior in the component. */
  kind: PickerEntryKind;

  /**
   * The session tool / shape type this entry maps to.
   * builtin → the shape `type` (also the drag payload + `createShapeAtCenter` arg);
   * custom  → `custom-shape:<itemId>` (activates the CustomShapeTool).
   */
  toolType: string;

  /** For builtin entries: the registry shape type used to render a canvas preview. */
  builtinType?: string;

  /** For custom entries: a base64 data-URL thumbnail, if one was captured. */
  thumbnail?: string;

  /** Fallback glyph (unicode/icon char) when no canvas path / thumbnail renders. */
  glyph?: string;
}
