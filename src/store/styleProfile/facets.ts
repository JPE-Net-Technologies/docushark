/**
 * The style facets (JP-33).
 *
 * Each facet owns one style axis and is a faithful port of the corresponding
 * branch from the old `extractStyleFromShape` / `getProfileUpdates` if-ladders.
 * Two behavioral contracts are preserved verbatim:
 *
 *  - Subtype fields are probed via an index-signature view of the shape, each
 *    read guarded by a `typeof` runtime check (so the `unknown` cast never
 *    widens a value that actually lands in the result).
 *  - The pre-existing `startArrow`/`endArrow` quirk (profile stores them as
 *    `string`, shapes store them as `boolean`) is left exactly as-is — extract
 *    only captures string values. Not "fixed" here; out of scope.
 *
 * Facets only ever conditionally assign optional fields (never assign
 * `undefined`), satisfying `exactOptionalPropertyTypes`.
 */

import type { BaseShape, IconDisplayMode, IconBadgeConfig, IconConfig } from '../../shapes/Shape';
import type { IconPosition, StyleFacet, StyleProfileProperties } from './types';
import { shapeSupportsIcon, shapeSupportsLabel } from './capabilities';

/** Index-signature view for guarded subtype probing. */
function asRecord(shape: BaseShape): Record<string, unknown> {
  return shape as unknown as Record<string, unknown>;
}

/**
 * Descriptor for a {@link makeCustomPropsFacet} field: a profile key whose value
 * lives in `shape.customProperties` under the same name.
 */
interface CustomPropField {
  /** Key on both the profile and the shape's customProperties. */
  readonly key: keyof StyleProfileProperties & string;
  /** Runtime kind used to guard extraction. */
  readonly kind: 'string' | 'number';
}

interface CustomPropsFacetConfig {
  readonly id: string;
  readonly names: readonly string[];
  readonly types: readonly string[];
  readonly fields: readonly CustomPropField[];
}

/**
 * Build a facet for a shape whose styleable fields live in
 * `shape.customProperties` (ERD entities, swimlanes, …). `extract` reads the
 * configured keys off customProperties; `apply` folds the set values back into a
 * *merged* customProperties copy (preserving unrelated custom data) and is a
 * no-op when the profile carries none of them. Adding the next such shape is
 * pure config — no new logic.
 */
function makeCustomPropsFacet(config: CustomPropsFacetConfig): StyleFacet {
  const typeSet = new Set(config.types);
  return {
    id: config.id,
    names: config.names,
    appliesTo: (type) => typeSet.has(type),
    extract: (shape) => {
      const raw = asRecord(shape)['customProperties'];
      if (!raw || typeof raw !== 'object') return {};
      const cp = raw as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const field of config.fields) {
        const value = cp[field.key];
        if (typeof value === field.kind) out[field.key] = value;
      }
      return out as Partial<StyleProfileProperties>;
    },
    apply: (props, shape) => {
      const bag = props as unknown as Record<string, unknown>;
      const values: Record<string, unknown> = {};
      for (const field of config.fields) {
        const value = bag[field.key];
        if (value !== undefined) values[field.key] = value;
      }
      if (Object.keys(values).length === 0) return {};
      const raw = asRecord(shape)['customProperties'];
      const existing = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      return { customProperties: { ...existing, ...values } };
    },
  };
}

/** Universal fill/stroke/strokeWidth/opacity — applies to every shape. */
const universalFacet: StyleFacet = {
  id: 'universal',
  names: ['Fill', 'Stroke', 'Stroke Width', 'Opacity'],
  appliesTo: () => true,
  extract: (shape) => ({
    fill: shape.fill ?? null,
    stroke: shape.stroke ?? null,
    strokeWidth: shape.strokeWidth ?? 2,
    opacity: shape.opacity ?? 1,
  }),
  apply: (props) => ({
    fill: props.fill,
    stroke: props.stroke,
    strokeWidth: props.strokeWidth,
    opacity: props.opacity,
  }),
};

/** Corner radius — rectangles and groups. */
const cornerRadiusFacet: StyleFacet = {
  id: 'cornerRadius',
  names: ['Corner Radius'],
  appliesTo: (type) => type === 'rectangle' || type === 'group',
  extract: (shape) => {
    const extra = asRecord(shape);
    return typeof extra['cornerRadius'] === 'number' ? { cornerRadius: extra['cornerRadius'] } : {};
  },
  apply: (props) => (props.cornerRadius !== undefined ? { cornerRadius: props.cornerRadius } : {}),
};

/** Label font size + color — any shape whose metadata says it carries a label. */
const labelFacet: StyleFacet = {
  id: 'label',
  names: ['Label Font Size', 'Label Color'],
  appliesTo: shapeSupportsLabel,
  extract: (shape, opts) => {
    if (!opts.includeLabelStyle) return {};
    const extra = asRecord(shape);
    const out: ReturnType<StyleFacet['extract']> = {};
    if (typeof extra['labelFontSize'] === 'number') out.labelFontSize = extra['labelFontSize'];
    if (typeof extra['labelColor'] === 'string') out.labelColor = extra['labelColor'];
    return out;
  },
  apply: (props) => {
    const out: ReturnType<StyleFacet['apply']> = {};
    if (props.labelFontSize !== undefined) out.labelFontSize = props.labelFontSize;
    if (props.labelColor !== undefined) out.labelColor = props.labelColor;
    return out;
  },
};

/** Font size + family — text shapes (fill doubles as text color via universal). */
const textFacet: StyleFacet = {
  id: 'text',
  names: ['Font Size', 'Font Family'],
  appliesTo: (type) => type === 'text',
  extract: (shape) => {
    const extra = asRecord(shape);
    const out: ReturnType<StyleFacet['extract']> = {};
    if (typeof extra['fontSize'] === 'number') out.fontSize = extra['fontSize'];
    if (typeof extra['fontFamily'] === 'string') out.fontFamily = extra['fontFamily'];
    return out;
  },
  apply: (props) => {
    const out: ReturnType<StyleFacet['apply']> = {};
    if (props.fontSize !== undefined) out.fontSize = props.fontSize;
    if (props.fontFamily !== undefined) out.fontFamily = props.fontFamily;
    return out;
  },
};

/** Start/end arrow style — lines and connectors. */
const arrowsFacet: StyleFacet = {
  id: 'arrows',
  names: ['Start Arrow', 'End Arrow'],
  appliesTo: (type) => type === 'line' || type === 'connector',
  extract: (shape) => {
    const extra = asRecord(shape);
    const out: ReturnType<StyleFacet['extract']> = {};
    if (typeof extra['startArrow'] === 'string') out.startArrow = extra['startArrow'];
    if (typeof extra['endArrow'] === 'string') out.endArrow = extra['endArrow'];
    return out;
  },
  apply: (props) => {
    const out: ReturnType<StyleFacet['apply']> = {};
    if (props.startArrow !== undefined) out.startArrow = props.startArrow;
    if (props.endArrow !== undefined) out.endArrow = props.endArrow;
    return out;
  },
};

/** Line style (solid/dashed) — connectors. */
const lineStyleFacet: StyleFacet = {
  id: 'lineStyle',
  names: ['Line Style'],
  appliesTo: (type) => type === 'connector',
  extract: (shape) => {
    const extra = asRecord(shape);
    return typeof extra['lineStyle'] === 'string' ? { lineStyle: extra['lineStyle'] } : {};
  },
  apply: (props) => (props.lineStyle !== undefined ? { lineStyle: props.lineStyle } : {}),
};

/** Background/border styling — groups. */
const groupFacet: StyleFacet = {
  id: 'group',
  names: ['Background Color', 'Border Color', 'Border Width'],
  appliesTo: (type) => type === 'group',
  extract: (shape) => {
    const extra = asRecord(shape);
    const out: ReturnType<StyleFacet['extract']> = {};
    if (typeof extra['backgroundColor'] === 'string') out.backgroundColor = extra['backgroundColor'];
    if (typeof extra['borderColor'] === 'string') out.borderColor = extra['borderColor'];
    if (typeof extra['borderWidth'] === 'number') out.borderWidth = extra['borderWidth'];
    return out;
  },
  apply: (props) => {
    const out: ReturnType<StyleFacet['apply']> = {};
    if (props.backgroundColor !== undefined) out.backgroundColor = props.backgroundColor;
    if (props.borderColor !== undefined) out.borderColor = props.borderColor;
    if (props.borderWidth !== undefined) out.borderWidth = props.borderWidth;
    return out;
  },
};

/**
 * ERD table styling — entity shapes. Row colors + attribute padding live on the
 * shape's `customProperties`.
 */
const erdFacet: StyleFacet = makeCustomPropsFacet({
  id: 'erd',
  names: ['Row Colors', 'Padding', 'Separator Inset'],
  types: ['erd-entity', 'erd-weak-entity'],
  fields: [
    { key: 'rowSeparatorColor', kind: 'string' },
    { key: 'rowBackgroundColor', kind: 'string' },
    { key: 'rowAlternateColor', kind: 'string' },
    { key: 'attributePaddingHorizontal', kind: 'number' },
    { key: 'attributePaddingVertical', kind: 'number' },
  ],
});

/**
 * Swimlane chrome — header band color + lane separator color/width, stored on
 * `customProperties`. First explicit-keys pilot of the adapter on a complex
 * library shape (JP-399). `headerSize` is intentionally excluded — it is
 * structural (layout), not style, so applying a profile never resizes chrome.
 */
const swimlaneFacet: StyleFacet = makeCustomPropsFacet({
  id: 'swimlane',
  names: ['Header Color', 'Separator Color', 'Separator Width'],
  types: ['activity-swimlane'],
  fields: [
    { key: 'headerBackground', kind: 'string' },
    { key: 'separatorColor', kind: 'string' },
    { key: 'separatorWidth', kind: 'number' },
  ],
});

/** Icon styling (all 8 icon fields) — any shape whose metadata supports icons. */
const iconFacet: StyleFacet = {
  id: 'icon',
  names: ['Icon', 'Icon Size', 'Icon Position'],
  appliesTo: shapeSupportsIcon,
  extract: (shape, opts) => {
    if (!opts.includeIconStyle) return {};
    const extra = asRecord(shape);
    const out: ReturnType<StyleFacet['extract']> = {};
    if (typeof extra['iconId'] === 'string') out.iconId = extra['iconId'];
    if (typeof extra['iconSize'] === 'number') out.iconSize = extra['iconSize'];
    if (typeof extra['iconPadding'] === 'number') out.iconPadding = extra['iconPadding'];
    if (typeof extra['iconColor'] === 'string') out.iconColor = extra['iconColor'];
    if (typeof extra['iconPosition'] === 'string') out.iconPosition = extra['iconPosition'] as IconPosition;
    if (typeof extra['iconDisplayMode'] === 'string') out.iconDisplayMode = extra['iconDisplayMode'] as IconDisplayMode;
    const iconBadge = extra['iconBadge'];
    if (iconBadge && typeof iconBadge === 'object') {
      // Shallow copy so later shape mutations don't bleed into the profile.
      out.iconBadge = { ...(iconBadge as IconBadgeConfig) };
    }
    const icons = extra['icons'];
    if (Array.isArray(icons)) {
      out.icons = icons.map((icon) => ({ ...(icon as IconConfig) }));
    }
    return out;
  },
  apply: (props) => {
    const out: ReturnType<StyleFacet['apply']> = {};
    if (props.iconId !== undefined) out.iconId = props.iconId;
    if (props.iconSize !== undefined) out.iconSize = props.iconSize;
    if (props.iconPadding !== undefined) out.iconPadding = props.iconPadding;
    if (props.iconColor !== undefined) out.iconColor = props.iconColor;
    if (props.iconPosition !== undefined) out.iconPosition = props.iconPosition;
    if (props.iconDisplayMode !== undefined) out.iconDisplayMode = props.iconDisplayMode;
    if (props.iconBadge !== undefined) out.iconBadge = props.iconBadge;
    if (props.icons !== undefined) out.icons = props.icons;
    return out;
  },
};

/**
 * All facets, in application order. Order matters only for `apply` precedence
 * (later facets win on key collisions — none currently collide).
 */
export const STYLE_FACETS: readonly StyleFacet[] = [
  universalFacet,
  cornerRadiusFacet,
  labelFacet,
  textFacet,
  arrowsFacet,
  lineStyleFacet,
  groupFacet,
  erdFacet,
  swimlaneFacet,
  iconFacet,
];
