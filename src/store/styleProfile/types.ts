/**
 * Core contracts for the per-shape style-profile adapter layer (JP-33).
 *
 * A style profile is a flat bag of concrete style values
 * ({@link StyleProfileProperties}). Translating that bag onto a concrete shape —
 * and reading it back off a shape — used to be three hand-written `if`-ladders
 * gated by a brittle string heuristic. It is now a set of composable
 * {@link StyleFacet}s, each owning one style axis (fill/stroke, label, icon,
 * ERD rows, …). A shape's "adapter" is simply the facets whose
 * {@link StyleFacet.appliesTo} is true for its type — resolved by the registry.
 *
 * This module is the dependency root: it imports only shape *types*, so the
 * facet/registry/capability modules can depend on it without forming a cycle
 * back through `styleProfileStore`.
 */

import type { BaseShape, IconDisplayMode, IconBadgeConfig, IconConfig } from '../../shapes/Shape';

/**
 * Icon position options persisted in a style profile.
 *
 * Intentionally narrower than the shape-level `IconPosition` in `Shape.ts`
 * (profiles only ever round-trip the corner/center positions). Kept verbatim
 * from the original `styleProfileStore` definition to preserve behavior.
 */
export type IconPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';

/**
 * Style properties that can be saved in a profile.
 * These are the common style properties across all shape types.
 */
export interface StyleProfileProperties {
  // Universal properties
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  opacity: number;

  // Rectangle/Group properties
  /** Optional - only applies to rectangles and groups */
  cornerRadius?: number;

  // Label properties
  /** Optional - label font size for shapes with labels */
  labelFontSize?: number;
  /** Optional - label color for shapes with labels */
  labelColor?: string;

  // Text shape properties
  /** Optional - font size for text shapes */
  fontSize?: number;
  /** Optional - font family for text shapes */
  fontFamily?: string;

  // Line/Connector properties
  /** Optional - start arrow style */
  startArrow?: string;
  /** Optional - end arrow style */
  endArrow?: string;
  /** Optional - line style (solid, dashed) */
  lineStyle?: string;

  // Group-specific properties
  /** Optional - background color for groups */
  backgroundColor?: string;
  /** Optional - border color for groups */
  borderColor?: string;
  /** Optional - border width for groups */
  borderWidth?: number;

  // ERD entity styling properties (applied into customProperties)
  /** Optional - row separator color */
  rowSeparatorColor?: string;
  /** Optional - row background color */
  rowBackgroundColor?: string;
  /** Optional - alternate row color for zebra striping */
  rowAlternateColor?: string;
  /** Optional - horizontal padding for attribute text */
  attributePaddingHorizontal?: number;
  /** Optional - vertical padding for attributes */
  attributePaddingVertical?: number;

  // Swimlane styling properties (applied into customProperties)
  /** Optional - swimlane header band color */
  headerBackground?: string;
  /** Optional - swimlane lane separator color */
  separatorColor?: string;
  /** Optional - swimlane lane separator width */
  separatorWidth?: number;

  // Icon properties (Rectangle, Ellipse, LibraryShape)
  /** Optional - icon ID reference */
  iconId?: string;
  /** Optional - icon size in pixels */
  iconSize?: number;
  /** Optional - icon padding from corner */
  iconPadding?: number;
  /** Optional - icon color override */
  iconColor?: string;
  /** Optional - icon position */
  iconPosition?: IconPosition;
  /** Optional - icon display mode ('inside' | 'badge' | 'icon-only') */
  iconDisplayMode?: IconDisplayMode;
  /** Optional - badge configuration when iconDisplayMode = 'badge' */
  iconBadge?: IconBadgeConfig;
  /** Optional - multi-icon configuration (overrides single-icon props when present) */
  icons?: IconConfig[];
}

/**
 * ERD-specific profile keys (applied into `shape.customProperties`).
 */
export type ErdProfileKey =
  | 'rowSeparatorColor'
  | 'rowBackgroundColor'
  | 'rowAlternateColor'
  | 'attributePaddingHorizontal'
  | 'attributePaddingVertical';

/**
 * Swimlane-specific profile keys (applied into `shape.customProperties`).
 */
export type SwimlaneProfileKey = 'headerBackground' | 'separatorColor' | 'separatorWidth';

/**
 * Profile keys that are stored flat on a profile but applied into
 * `shape.customProperties` rather than onto the shape directly. They are stripped
 * from {@link ShapeStyleUpdate} because their owning facet folds them into a
 * merged `customProperties` object instead.
 */
export type CustomPropertyProfileKey = ErdProfileKey | SwimlaneProfileKey;

/**
 * Concrete shape-field updates produced by applying a profile to a shape.
 *
 * Structurally a `Partial<Shape>`: the raw customProperties-backed keys are
 * replaced by a single (already-merged) `customProperties` object, so the result
 * can be handed straight to `updateShape(id, update)` with no special-casing at
 * the call site.
 */
export type ShapeStyleUpdate = Omit<Partial<StyleProfileProperties>, CustomPropertyProfileKey> & {
  customProperties?: Record<string, unknown>;
};

/**
 * Fully-resolved extraction options (every flag concrete). The public
 * `ExtractStyleOptions` is the partial form; the store resolves it before
 * dispatching to facets.
 */
export interface ResolvedExtractOptions {
  /** Include icon properties (iconId, iconSize, …). */
  includeIconStyle: boolean;
  /** Include label properties (labelFontSize, labelColor). */
  includeLabelStyle: boolean;
}

/**
 * One reusable style axis (universal fill/stroke, label, icon, ERD rows, …).
 *
 * A facet knows which shape *types* it applies to, how to read its fields off a
 * shape into the flat profile bag ({@link extract}), and how to translate
 * profile values into concrete shape-field updates ({@link apply}).
 *
 * `apply(props, shape)` is deliberately the same primitive a future "Dynamic
 * Style Profiles" `styleProfileRef` would call to resolve/merge a referenced
 * profile onto a shape — no separate code path needed.
 */
export interface StyleFacet {
  /** Stable id for ordering/debugging. */
  readonly id: string;
  /** Human-readable property names this facet contributes (drives the UI hint). */
  readonly names: readonly string[];
  /** Whether this facet applies to the given shape type. */
  appliesTo(type: string): boolean;
  /** Pull this facet's concrete fields off a shape into the flat profile bag. */
  extract(shape: BaseShape, opts: ResolvedExtractOptions): Partial<StyleProfileProperties>;
  /**
   * Translate profile values into concrete shape-field updates, merging with
   * the existing shape where a field is a sub-object (ERD `customProperties`).
   */
  apply(props: StyleProfileProperties, shape: BaseShape): ShapeStyleUpdate;
}
