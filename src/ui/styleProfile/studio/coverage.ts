/**
 * What a style profile actually covers — the model behind the Style Profile
 * Studio.
 *
 * A profile is a **master memory**: a non-destructive union of every shape ever
 * saved into it (JP-399). That model is powerful and completely invisible in
 * the UI, because a profile has always been presented as one colour swatch. Two
 * profiles that behave entirely differently — one tuned across swimlanes, ERD
 * entities and icons, one carrying a fill and nothing else — look identical.
 *
 * This module makes the union legible by answering two questions:
 *
 *  1. **Which sets of shapes can this profile reach?** Not one row per shape
 *     type: the shape libraries register hundreds of types and a per-type list
 *     would be unreadable. Types are bucketed by their **facet signature** —
 *     the set of style facets that apply to them — so every shape that is
 *     styleable *identically* collapses into one family. That grouping is also
 *     the truer statement, and it is what "editable sets of shapes with their
 *     reachable styles" means.
 *
 *  2. **For each family, which keys are saved and which are inherited?** Saved =
 *     the profile carries a value, so applying it sets that field. Inherited =
 *     the family reads the key but the profile has no value, so the shape keeps
 *     its own. This is the distinction that separates "genuinely tuned for
 *     swimlanes" from "swimlanes just get the universal fill", and nothing in
 *     the product has ever surfaced it.
 *
 * Pure and registry-driven: no hardcoded family list to drift out of date as
 * shapes are added.
 */

import { shapeRegistry } from '../../../shapes/ShapeRegistry';
import { resolveStyleAdapter } from '../../../store/styleProfile';
import type { StyleProfileProperties } from '../../../store/styleProfile';
import type { StyleProfile } from '../../../store/styleProfileStore';

/** One profile key within a family, and whether the profile carries a value. */
export interface StudioKey {
  /** The profile property key. */
  key: keyof StyleProfileProperties;
  /** Human label from the owning facet, falling back to the key itself. */
  label: string;
  /** Facet that owns this key — used to group keys within a family. */
  facetId: string;
  /** True when the profile has a value: applying it will set this field. */
  saved: boolean;
  /** The saved value, when there is one. */
  value: StyleProfileProperties[keyof StyleProfileProperties] | undefined;
}

/** A set of shape types that are styleable identically. */
export interface StudioFamily {
  /** Stable id: the sorted facet signature, so it survives registry order. */
  id: string;
  /** Display label, from the representative type. */
  label: string;
  /** The type rendered as this family's preview. */
  representativeType: string;
  /** Every registered type in this family (may be large for library shapes). */
  types: string[];
  /** The facet ids that apply to this family. */
  facetIds: string[];
  /** Every key this family can receive, saved and inherited alike. */
  keys: StudioKey[];
  /**
   * True when the profile saves something for this family **beyond** the
   * universal fill/stroke/width/opacity.
   *
   * Deliberately not "has any saved key": every profile carries the four
   * universal keys by construction, so that definition makes every reachable
   * family tuned and the coverage number reads a useless "10 of 10". The
   * question worth answering is whether the profile has been taught anything
   * specific to this family — which is exactly what separates a profile that
   * genuinely knows about swimlanes from one that will only ever paint them
   * the universal fill.
   */
  hasSavedKeys: boolean;
}

/** Coverage summary for the manager's card indicator. */
export interface StudioCoverage {
  /** Families tuned beyond the universal facet (see `hasSavedKeys`). */
  saved: number;
  /** Families the profile could reach at all. */
  reachable: number;
}

/** The four keys every profile carries by construction — they are required by
 *  `StyleProfileProperties`, so they can be neither absent nor forgotten. */
export const UNIVERSAL_KEYS: readonly string[] = ['fill', 'stroke', 'strokeWidth', 'opacity'];

/**
 * Core shapes register handlers but no metadata (JP-33 found the same gap when
 * resolving capabilities), so a label has to fall back to something. These are
 * the display names the rest of the UI already uses.
 */
const CORE_LABELS: Record<string, string> = {
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  connector: 'Connector',
  text: 'Text',
  group: 'Group',
  image: 'Image',
  file: 'File',
};

/** Prefer a core shape as a family's face — a recognisable rectangle reads
 *  better than whichever library shape happened to sort first. */
const REPRESENTATIVE_PRIORITY = [
  'rectangle',
  'ellipse',
  'text',
  'connector',
  'line',
  'group',
];

function labelForType(type: string): string {
  const meta = shapeRegistry.getMetadata(type);
  if (meta?.name) return meta.name;
  const core = CORE_LABELS[type];
  if (core) return core;
  // `erd-weak-entity` → `Erd weak entity`. Not beautiful, but honest and never
  // wrong, which beats a hardcoded list that silently misses new shapes.
  return type.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function pickRepresentative(types: string[]): string {
  for (const preferred of REPRESENTATIVE_PRIORITY) {
    if (types.includes(preferred)) return preferred;
  }
  return [...types].sort()[0] ?? 'rectangle';
}

/**
 * Build the family list for a profile.
 *
 * Every registered shape type is bucketed by its facet signature; each bucket
 * becomes one family whose keys are the union of its facets' keys, marked saved
 * or inherited against `profile`.
 */
export function resolveStudioFamilies(profile: StyleProfile): StudioFamily[] {
  const buckets = new Map<string, { types: string[]; facetIds: string[] }>();

  for (const type of shapeRegistry.getRegisteredTypes()) {
    const facets = resolveStyleAdapter(type);
    // Sorted so the signature is order-independent — a registry that returns
    // facets in a different order must not produce a different family.
    const facetIds = facets.map((f) => f.id).sort();
    const signature = facetIds.join('+');
    const existing = buckets.get(signature);
    if (existing) existing.types.push(type);
    else buckets.set(signature, { types: [type], facetIds });
  }

  const families: StudioFamily[] = [];
  for (const [signature, { types, facetIds }] of buckets) {
    const representativeType = pickRepresentative(types);
    // Re-resolve from the representative so key order matches apply order.
    const facets = resolveStyleAdapter(representativeType);

    const keys: StudioKey[] = [];
    for (const facet of facets) {
      facet.keys.forEach((key, index) => {
        const saved = Object.prototype.hasOwnProperty.call(profile.properties, key)
          && profile.properties[key] !== undefined;
        keys.push({
          key,
          // Facets present fewer labels than keys (ERD: 3 labels, 5 keys), so a
          // positional label is only used where one exists.
          label: facet.names[index] ?? prettifyKey(key),
          facetId: facet.id,
          saved,
          value: saved ? profile.properties[key] : undefined,
        });
      });
    }

    families.push({
      id: signature,
      label: labelForType(representativeType),
      representativeType,
      types: types.sort(),
      facetIds,
      keys,
      hasSavedKeys: keys.some((k) => k.saved && !UNIVERSAL_KEYS.includes(k.key)),
    });
  }

  // Families with saved keys first (the interesting ones), then by breadth —
  // a family covering many shape types matters more than a one-off — then
  // alphabetically for stability.
  return families.sort((a, b) => {
    if (a.hasSavedKeys !== b.hasSavedKeys) return a.hasSavedKeys ? -1 : 1;
    if (a.types.length !== b.types.length) return b.types.length - a.types.length;
    return a.label.localeCompare(b.label);
  });
}

/** `rowSeparatorColor` → `Row separator color`. */
export function prettifyKey(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Coverage summary, reused as the manager's card indicator.
 *
 * Memoized on the profile's serialized properties **and** the registered-type
 * count. Resolving families walks every registered shape type — several hundred
 * once the libraries load — which is fine once for a modal but not once per
 * card per render. Including the type count in the key means a library
 * registering later invalidates the cache rather than serving a stale number.
 */
const coverageCache = new Map<string, StudioCoverage>();

export function getStudioCoverage(profile: StyleProfile): StudioCoverage {
  const cacheKey = `${shapeRegistry.getRegisteredTypes().length}:${JSON.stringify(profile.properties)}`;
  const hit = coverageCache.get(cacheKey);
  if (hit) return hit;

  const families = resolveStudioFamilies(profile);
  const coverage: StudioCoverage = {
    saved: families.filter((f) => f.hasSavedKeys).length,
    reachable: families.length,
  };
  // Bound the cache: profiles are few, but a user editing one in the Studio
  // produces a fresh key on every keystroke-level change.
  if (coverageCache.size > 64) coverageCache.clear();
  coverageCache.set(cacheKey, coverage);
  return coverage;
}

/**
 * Remove a key from a profile — the inverse the master-memory union has never
 * had. Saving into a profile is additive by design, so until now a key, once
 * present, could only be overwritten and never dropped back to inherited.
 *
 * Returns a new properties bag; the four universal keys are required by the
 * type and are refused rather than deleted (a profile without a fill isn't
 * representable, and pretending otherwise would produce an invalid profile).
 */
export function forgetKey(
  properties: StyleProfileProperties,
  key: keyof StyleProfileProperties,
): StyleProfileProperties {
  if (UNIVERSAL_KEYS.includes(key)) return properties;
  const next = { ...properties };
  delete next[key];
  return next;
}
