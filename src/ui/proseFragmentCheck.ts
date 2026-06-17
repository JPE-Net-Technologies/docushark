/**
 * proseFragmentCheck — pre-flight a prose `Y.XmlFragment` against the client
 * schema *before* the live collaborative editor binds to it (JP-328, Pillar 1a).
 *
 * For a relay document the editor adopts the authoritative Y.Doc fragment via
 * Tiptap's `Collaboration` extension, and **y-prosemirror builds the ProseMirror
 * doc straight from the fragment** (`yXmlFragmentToProseMirrorRootNode`) —
 * bypassing Tiptap's content parser. So a schema-invalid node (an unknown type,
 * or an atom carrying children) isn't fitted-to-schema the way pasted HTML is;
 * it reaches ReactNodeView reconciliation and throws "Cannot read properties of
 * undefined (reading 'children')" *during render*, blanking the page.
 *
 * Tiptap's `enableContentCheck` / `onContentError` does **not** fire on this
 * path (it only guards the content-parser path), so we reproduce the same build
 * here and validate it with ProseMirror's own `Node.check()`. If it throws, the
 * panel renders the crash-safe read-only `ProsePreview` (which loads the HTML
 * projection through ProseMirror's lenient `DOMParser`) instead of mounting the
 * editor — content stays visible, never blank.
 *
 * This is an *optimization* over the `ProseErrorBoundary` fallback: it avoids
 * the mount-crash-then-recover flash and the console noise. The boundary remains
 * the backstop for any crash this pre-check can't foresee.
 */

import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type { Schema } from 'prosemirror-model';
import type { Doc as YDoc } from 'yjs';
import { sharedProseExtensions } from './TiptapEditor';

let cachedSchema: Schema | null = null;

/**
 * The schema the collaborative editor actually builds — StarterKit with history
 * off and the lowlight codeBlock swapped in, plus the shared prose extensions.
 * `Collaboration` adds no nodes, so it's omitted. Mirrors
 * `CollaborativeProseEditor`'s extension set and the `proseSchemaContract` test.
 * Built once and cached (the extension set is static for the app's lifetime).
 */
export function collabProseSchema(): Schema {
  if (!cachedSchema) {
    cachedSchema = getSchema([
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        codeBlock: false,
        history: false,
      }),
      ...sharedProseExtensions,
    ]);
  }
  return cachedSchema;
}

/**
 * `true` if the fragment builds into a schema-valid ProseMirror doc the live
 * editor can render; `false` if building or validation throws (the caller should
 * fall back to read-only `ProsePreview`). Read-only: builds a throwaway PM node,
 * never mutates the Y.Doc.
 */
export function isFragmentRenderable(ydoc: YDoc, field: string): boolean {
  try {
    const frag = ydoc.getXmlFragment(field);
    // An empty fragment is trivially fine: the live editor seeds an empty
    // paragraph itself, so don't reject it here (the bare `doc` would fail its
    // `block+` content rule). The panel only mounts on an empty fragment once
    // the relay has confirmed it (`isSynced`).
    if (frag.length === 0) return true;
    const root = yXmlFragmentToProseMirrorRootNode(frag, collabProseSchema());
    // `check()` recurses the whole tree, asserting content expressions and atom
    // constraints — the exact violations that crash NodeView reconciliation.
    root.check();
    return true;
  } catch (err) {
    console.warn(
      `[prose] fragment "${field}" failed the schema pre-check; rendering read-only`,
      err,
    );
    return false;
  }
}
