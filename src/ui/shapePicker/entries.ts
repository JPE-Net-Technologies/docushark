/**
 * Builds the normalized `PickerEntry` list the ShapePicker renders from, out of
 * the two underlying sources (ShapeRegistry metadata + custom-library items),
 * and derives the search keywords (name/category/description tokens + a small
 * synonym map) so intent words like "db", "if", or "start" resolve to the right
 * shape. Pure + data-only so it can be unit-tested without React or the stores.
 */

import type { ShapeMetadata, ShapeLibraryCategory } from '../../shapes/ShapeMetadata';
import type { CustomShapeItem } from '../../storage/ShapeLibraryTypes';
import type { PickerEntry, PickerCategory } from './types';

/** Display labels for picker categories (superset of ShapeLibraryCategory). */
export const PICKER_CATEGORY_LABELS: Record<string, string> = {
  basic: 'Basic',
  flowchart: 'Flowchart',
  erd: 'ERD',
  'uml-class': 'UML Class',
  'uml-usecase': 'UML Use Case',
  'uml-sequence': 'UML Sequence',
  'uml-activity': 'UML Activity',
  custom: 'Custom',
};

/**
 * Display order for the category pills. 'all' is prepended by the component;
 * 'custom' is appended only when custom shapes exist.
 */
export const PICKER_CATEGORY_ORDER: PickerCategory[] = [
  'basic',
  'flowchart',
  'erd',
  'uml-class',
  'uml-usecase',
  'uml-sequence',
  'uml-activity',
];

/**
 * Core shapes worth surfacing in the picker. The other 'basic' shapes
 * (line/connector/group/file) are interactive draw tools or need a payload, so
 * they're excluded — `createShapeAtCenter` on them would be degenerate.
 */
const BASIC_ALLOWLIST = new Set(['rectangle', 'ellipse', 'text']);

/**
 * Per-token search synonyms. When a derived keyword matches a key, its aliases
 * are added so the user's natural wording finds the canonical shape.
 */
const TOKEN_SYNONYMS: Record<string, string[]> = {
  decision: ['if', 'branch', 'condition', 'conditional', 'choice'],
  terminator: ['start', 'end', 'begin', 'stop', 'terminal'],
  process: ['step', 'action', 'task', 'rectangle', 'box'],
  action: ['step', 'task', 'activity'],
  data: ['input', 'output', 'parallelogram', 'io'],
  document: ['doc', 'report', 'page', 'file'],
  predefined: ['subroutine', 'subprocess'],
  preparation: ['setup', 'init'],
  entity: ['table', 'er'],
  relationship: ['relation', 'link', 'join'],
  attribute: ['field', 'property', 'column'],
  class: ['object', 'oop'],
  interface: ['contract', 'protocol'],
  enumeration: ['enum', 'constants'],
  package: ['namespace', 'module', 'folder'],
  note: ['comment', 'annotation', 'callout'],
  actor: ['user', 'person', 'stick', 'role'],
  use: ['usecase', 'scenario', 'oval'],
  boundary: ['container', 'system', 'frame'],
  lifeline: ['participant', 'object'],
  activation: ['bar', 'execution'],
  fragment: ['frame', 'combined', 'alt', 'loop', 'opt'],
  initial: ['start', 'begin', 'dot'],
  final: ['end', 'stop'],
  fork: ['split', 'parallel', 'concurrent'],
  join: ['merge', 'sync'],
  merge: ['join', 'combine'],
  swimlane: ['lane', 'pool', 'partition'],
  signal: ['event', 'message'],
  buffer: ['queue', 'store'],
  datastore: ['db', 'database', 'storage'],
  store: ['db', 'database', 'storage'],
  pin: ['port', 'parameter'],
  object: ['node', 'instance'],
  destruction: ['delete', 'destroy'],
  key: ['primary', 'pk', 'id'],
  weak: ['optional'],
  ellipse: ['circle', 'oval', 'round'],
  rectangle: ['box', 'rect', 'square'],
  erd: ['entity', 'relationship', 'database', 'er'],
  uml: ['unified', 'modeling'],
};

/**
 * Split a label/identifier into lowercased search tokens: handles spaces,
 * hyphens, slashes, and camelCase boundaries. Keeps tokens of length >= 2.
 */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2);
}

/** Derive the deduped keyword set for an entry from its text fields. */
function deriveKeywords(parts: string[]): string[] {
  const tokens = new Set<string>();
  for (const part of parts) {
    for (const tok of tokenize(part)) {
      tokens.add(tok);
      const aliases = TOKEN_SYNONYMS[tok];
      if (aliases) {
        for (const alias of aliases) tokens.add(alias);
      }
    }
  }
  return [...tokens];
}

/** Label for a category, falling back to the raw key. */
export function categoryLabel(category: string): string {
  return PICKER_CATEGORY_LABELS[category] ?? category;
}

/**
 * Build picker entries from built-in shape metadata. Excludes basic shapes that
 * aren't in the curated allowlist.
 */
export function buildBuiltinEntries(metadata: ShapeMetadata[]): PickerEntry[] {
  const entries: PickerEntry[] = [];
  for (const meta of metadata) {
    const category = meta.category as ShapeLibraryCategory;
    if (category === 'basic' && !BASIC_ALLOWLIST.has(meta.type)) continue;
    if (category === 'custom') continue; // custom comes from the custom store
    const label = categoryLabel(category);
    entries.push({
      id: meta.type,
      name: meta.name,
      category,
      categoryLabel: label,
      keywords: deriveKeywords([meta.name, label, meta.description ?? '', meta.type]),
      kind: 'builtin',
      toolType: meta.type,
      builtinType: meta.type,
      glyph: meta.icon,
    });
  }
  return entries;
}

/** Build picker entries from custom-library items. */
export function buildCustomEntries(items: CustomShapeItem[]): PickerEntry[] {
  const label = categoryLabel('custom');
  return items.map((item) => ({
    id: `custom-shape:${item.id}`,
    name: item.name,
    category: 'custom',
    categoryLabel: label,
    keywords: deriveKeywords([item.name, label]),
    kind: 'custom' as const,
    toolType: `custom-shape:${item.id}`,
    ...(item.thumbnail ? { thumbnail: item.thumbnail } : {}),
  }));
}

/**
 * Build the full entry list. Built-ins first (in registry order), custom last.
 */
export function buildEntries(
  builtinMetadata: ShapeMetadata[],
  customItems: CustomShapeItem[]
): PickerEntry[] {
  return [...buildBuiltinEntries(builtinMetadata), ...buildCustomEntries(customItems)];
}
