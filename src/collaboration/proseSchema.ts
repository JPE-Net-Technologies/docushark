/**
 * Prose schema registry (JP-193).
 *
 * The CRDT-native prose write primitive (`YjsDocument.setProse`/`appendProse`)
 * must build ProseMirror nodes with the SAME schema the live editor uses, so
 * `updateYFragment` diffs them into the shared `prose:<pageId>` fragment exactly
 * as a typed edit would. But that schema is defined by the editor's Tiptap
 * extensions — some (EmbeddedGroup) pull React + UI components, and the whole
 * stack (katex, nspell) is deliberately lazy-loaded out of the main bundle.
 *
 * Statically importing the extensions into the collaboration layer would invert
 * layering and drag UI/heavy deps into headless code. So the prose chunk
 * *registers* its built schema when it loads (see `TiptapEditor.tsx`), and the
 * collaboration layer reads it here — the same seam as `registerAutoSaveFlush` /
 * `registerTokenRefresher`.
 *
 * Consequence: a programmatic prose write requires the prose chunk to have
 * loaded (an editor shown at least once). That holds while the only writers are
 * editor-adjacent; a future pre-editor injector must ensure the chunk is
 * imported first.
 */
import type { Schema } from '@tiptap/pm/model';

let proseSchema: Schema | null = null;

/** Register the editor's ProseMirror schema (called from the prose chunk at load). */
export function registerProseSchema(schema: Schema): void {
  proseSchema = schema;
}

/** True once a schema has been registered. */
export function hasProseSchema(): boolean {
  return proseSchema !== null;
}

/**
 * The registered prose schema. Throws if called before registration — a
 * programmatic prose write before the editor schema is wired is a bug, not a
 * silent no-op to swallow.
 */
export function getProseSchema(): Schema {
  if (!proseSchema) {
    throw new Error(
      '[proseSchema] no schema registered — the prose chunk must load (an editor shown) ' +
        'before a programmatic prose write (JP-193)',
    );
  }
  return proseSchema;
}

/** Test-only: clear the registered schema between cases. */
export function __resetProseSchemaForTests(): void {
  proseSchema = null;
}
