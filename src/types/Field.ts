/**
 * Document Fields (Phase 3) — reusable named values that propagate through the
 * prose via `{{field}}` placeholders.
 *
 * A *field* is a plain `name → value` pair (a defined term for lawyers — "the
 * Company", "Effective Date" — a version/config string for engineers, etc.).
 * Edit a value once and every `{{field}}` reference repaints. The data model is
 * deliberately thin (string values only); it is also kept **MCP-forward-compatible**
 * — the storage shape below is the exact JSON a future relay `set_fields` tool
 * will write into `DiagramDocument.fields`, and the editor node serializes as a
 * `<span data-field data-name data-label>` so a future Markdown→HTML adapter can
 * turn `{{name}}` into the same node. v1 ships **client-side only** (no relay/MCP
 * wiring yet) — see the Fields manager's info banner.
 *
 * This file is the data model only — no store, formatting, or network logic.
 */

/**
 * A single document field. `value` is plain text in v1; the interface is kept
 * open (extra keys tolerated) so a future `type` (date / number / select) can be
 * added additively without a migration.
 */
export interface Field {
  /** Unique key within the document — the `{{name}}` token. */
  name: string;
  /** The current value substituted for `{{name}}`. Plain text in v1. */
  value: string;
}

/**
 * A document's field library: fields keyed by name, plus an explicit display
 * order. Mirrors the id-map + order-array shape of {@link ReferenceLibrary}.
 * **This is the MCP wire contract** for `DiagramDocument.fields` — a future
 * relay `set_fields` tool writes exactly this JSON.
 */
export interface FieldLibrary {
  fields: Record<string, Field>;
  order: string[];
}

/** Create an empty field library. */
export function createEmptyFieldLibrary(): FieldLibrary {
  return { fields: {}, order: [] };
}

/**
 * Runtime guard: is `x` a structurally-valid {@link FieldLibrary}? Used to
 * defensively normalize untrusted input (an imported document / partial
 * snapshot) before loading — a malformed value degrades to an empty library,
 * never throws. Mirrors `isReferenceLibrary`.
 */
export function isFieldLibrary(x: unknown): x is FieldLibrary {
  if (!x || typeof x !== 'object') return false;
  const lib = x as Record<string, unknown>;
  return (
    typeof lib['fields'] === 'object' &&
    lib['fields'] !== null &&
    !Array.isArray(lib['fields']) &&
    Array.isArray(lib['order'])
  );
}

/**
 * A built-in computed field. Its value is derived live (never stored) — so
 * `{{today}}` always resolves to the current date when rendered. The `name`
 * shadows any same-named user field (computed wins; documented in the manager).
 */
export interface ComputedField {
  name: string;
  /** Human label for the manager / suggestion dropdown. */
  label: string;
  /** Resolve the live value (self-contained — date math only in v1). */
  resolve: () => string;
}

/**
 * The built-in computed fields. Self-contained date values only in v1
 * (`docTitle` / `author` need a document-metadata accessor — deferred).
 */
export const COMPUTED_FIELDS: ReadonlyArray<ComputedField> = [
  { name: 'today', label: "Today's date", resolve: () => new Date().toLocaleDateString() },
  { name: 'now', label: 'Current date & time', resolve: () => new Date().toLocaleString() },
];

/** Look up a computed field by name (case-insensitive), or `undefined`. */
export function getComputedField(name: string): ComputedField | undefined {
  const n = name.trim().toLowerCase();
  return COMPUTED_FIELDS.find((c) => c.name.toLowerCase() === n);
}
