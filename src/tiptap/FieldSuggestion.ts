/**
 * FieldSuggestion — inline `{{`-trigger autocomplete for document fields
 * (Phase 3 — Document Fields).
 *
 * Typing `{{` in prose opens a dropdown of the document's fields + the built-in
 * computed fields, filtered live by what you type; picking one replaces the
 * `{{query` token with a `fieldRef` node. A non-matching query offers a
 * "Create field" row that defines an empty field on the spot. `{{name}}` is the
 * same token humans type here and (in a future slice) MCP agents emit in
 * Markdown — one mental model.
 *
 * Built on the shared `createTriggerPlugin` factory (the same mechanism behind
 * the `/` slash menu), so it works identically in both prose editors when shared
 * via `sharedProseExtensions`. It owns no nodes/marks, so the headless schema
 * (`registerProseSchema`) and collab are unaffected. Requires the `fieldRef`
 * node (also shared) to be present in the schema.
 */

import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { createTriggerPlugin, type TriggerState, type TriggerMatch } from './triggerPlugin';
import { useFieldStore } from '../store/fieldStore';
import { COMPUTED_FIELDS, type Field } from '../types/Field';
import './FieldSuggestion.css';

const fieldSuggestionKey = new PluginKey<TriggerState>('fieldSuggestion');

/** A row in the `{{` dropdown. */
export type FieldOption =
  | { kind: 'field'; name: string; value: string }
  | { kind: 'computed'; name: string; label: string }
  | { kind: 'create'; name: string };

/**
 * Match a `{{`-trigger at the end of the text before the caret: `{{` followed
 * by the query (any char but `{` or `}` — so spaces are allowed in field names,
 * a closing `}` ends the token, and a third `{` opens a fresh trigger rather
 * than extending the query). The leading `(?:^|[^{])` plus the brace-free query
 * keep a stray triple-brace from matching. Returns the query and the offset of
 * the first `{` within `textBefore`, or `null`. Exported pure for unit testing.
 */
export function matchFieldTrigger(textBefore: string): TriggerMatch | null {
  const m = /(?:^|[^{])\{\{([^}{]*)$/.exec(textBefore);
  if (!m) return null;
  const query = m[1] ?? '';
  // Offset of the first `{`, independent of whether the `(?:^|[^{])` matched a
  // leading char: (match end) - query.length - 2 (the two braces).
  const from = m.index + m[0].length - query.length - 2;
  return { query, from };
}

/**
 * Build the dropdown options for `query` from the given user fields: matching
 * user fields + matching computed fields, plus a synthetic "create" row when the
 * (non-empty) query doesn't exactly name an existing field. Pure — unit-tested.
 */
export function buildFieldOptions(query: string, userFields: Field[]): FieldOption[] {
  const q = query.trim().toLowerCase();
  const fields: FieldOption[] = userFields
    .filter((f) => !q || f.name.toLowerCase().includes(q))
    .map((f) => ({ kind: 'field', name: f.name, value: f.value }));
  const computed: FieldOption[] = COMPUTED_FIELDS.filter(
    (c) => !q || c.name.toLowerCase().includes(q)
  ).map((c) => ({ kind: 'computed', name: c.name, label: c.label }));

  const options = [...fields, ...computed];

  const trimmed = query.trim();
  const exact = options.some((o) => o.name.toLowerCase() === trimmed.toLowerCase());
  if (trimmed && !exact) {
    options.push({ kind: 'create', name: trimmed });
  }
  return options;
}

function getItems(query: string): FieldOption[] {
  return buildFieldOptions(query, useFieldStore.getState().listFields());
}

/** Build a dropdown row: name + a muted hint (value / "Computed" / "Create"). */
function renderFieldRow(option: FieldOption): HTMLElement {
  const row = document.createElement('span');
  row.className = 'field-suggest-row';

  const name = document.createElement('span');
  name.className = 'field-suggest-name';
  name.textContent = option.kind === 'create' ? `Create field "${option.name}"` : option.name;
  row.appendChild(name);

  const hint = document.createElement('span');
  hint.className = 'field-suggest-hint';
  if (option.kind === 'field') hint.textContent = option.value || '(empty)';
  else if (option.kind === 'computed') hint.textContent = 'Computed';
  else hint.textContent = 'New field';
  row.appendChild(hint);

  return row;
}

export const FieldSuggestion = Extension.create({
  name: 'fieldSuggestion',

  addProseMirrorPlugins() {
    return [
      createTriggerPlugin<FieldOption>({
        pluginKey: fieldSuggestionKey,
        popupClass: 'field-suggest',
        match: matchFieldTrigger,
        getItems,
        rowKey: (option) => `${option.kind}:${option.name}`,
        renderRow: renderFieldRow,
        commit: (view, option, range) => {
          const fieldNode = view.state.schema.nodes['fieldRef'];
          if (!fieldNode) return;
          // A "create" row defines an empty field first; then every kind inserts
          // a fieldRef by name (the nodeView resolves the value live).
          if (option.kind === 'create') {
            useFieldStore.getState().setField(option.name, '');
          }
          const node = fieldNode.create({ name: option.name });
          view.dispatch(view.state.tr.replaceWith(range.from, range.to, node));
        },
      }),
    ];
  },
});
