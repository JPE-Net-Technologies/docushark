/**
 * Both prose editors must configure ProseMirror from one place (JP-496).
 *
 * There are two prose editors — `TiptapEditor` (local, history-backed) and
 * `CollaborativeProseEditor` (Yjs-bound) — and `sharedProseExtensions` exists
 * precisely so their node and mark sets cannot drift. **`editorProps` never got
 * the same treatment.** Each declared its own `attributes` / `handlePaste` /
 * `handleDrop`, and they were identical only because JP-495 happened to change
 * both by hand.
 *
 * The failure this guards is quiet: a handler added to one editor is simply
 * absent from the other. Nothing fails to compile, no test breaks, and the
 * collaborative editor — where a missing guard costs more — is the one more
 * easily forgotten. JP-495's `handleDrop` was a *data-loss* guard (a file
 * dropped on the page makes the browser navigate away, discarding unsaved
 * edits), so "present in one editor only" is a real bug, not a tidiness point.
 *
 * A source scan rather than a runtime assertion because the thing being checked
 * is *how the editors are wired*, not what they do once wired — the divergence
 * exists in the source before it ever reaches a running editor.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Every editor that mounts prose. Add a new one here when it appears. */
const PROSE_EDITORS = ['TiptapEditor.tsx', 'CollaborativeProseEditor.tsx'] as const;

function read(file: string): string {
  return readFileSync(resolve(__dirname, file), 'utf8');
}

describe('prose editorProps parity', () => {
  for (const file of PROSE_EDITORS) {
    it(`${file} configures editorProps from the shared object`, () => {
      const source = read(file);

      // Find every `editorProps:` assignment and check the value it is given
      // mentions the shared object. This tolerates a deliberate extension
      // (`{ ...sharedProseEditorProps, handleKeyDown }`) while rejecting an
      // editor that quietly restates the common set inline.
      const assignments = [...source.matchAll(/editorProps:\s*([\s\S]{0,200})/g)];

      expect(
        assignments.length,
        `${file} declares no editorProps at all — if that is intentional, remove it from ` +
          `PROSE_EDITORS; otherwise it is missing the shared paste/drop guards`,
      ).toBeGreaterThan(0);

      for (const [, value] of assignments) {
        expect(
          value?.includes('sharedProseEditorProps'),
          `${file} sets editorProps without spreading sharedProseEditorProps. Both prose ` +
            `editors must share one editorProps object, or a handler added to one (JP-495's ` +
            `handleDrop is a data-loss guard) is silently absent from the other.`,
        ).toBe(true);
      }
    });
  }

  it('the shared object actually carries the guards worth sharing', () => {
    // Without this, the parity check above stays green while the shared object
    // is hollowed out — both editors would agree on nothing at all. Asserted on
    // the source of the definition, since these are ProseMirror callbacks with
    // no meaningful runtime identity to inspect.
    const source = read('TiptapEditor.tsx');
    const definition = source.slice(source.indexOf('export const sharedProseEditorProps'));

    expect(
      definition.length,
      'sharedProseEditorProps is not exported from TiptapEditor.tsx',
    ).toBeGreaterThan(0);

    for (const key of ['attributes', 'handlePaste', 'handleDrop']) {
      expect(
        definition.slice(0, 800).includes(key),
        `sharedProseEditorProps no longer defines '${key}' — either both editors just lost it, ` +
          `or it moved and this guard needs updating`,
      ).toBe(true);
    }
  });
});
