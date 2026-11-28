/**
 * Guard for GHSA-cp6q-959q-f8rh (DSK-249). Tiptap 2's `mergeAttributes` copies
 * keys with plain assignment, so an object with an own `__proto__` key (which
 * `JSON.parse` makes) becomes the merged object's prototype. ProseMirror's
 * serializer then writes the inherited values, `onerror` included, onto the
 * element. Tiptap fixed it only in version 3.
 *
 * The attacker's way in would be an attribute renderer that returns, or
 * spreads, a value taken from the document: Tiptap merges every renderer's
 * output with `mergeAttributes`. Every renderer today returns a fresh object
 * with fixed keys, so a shared document can't reach it. This test keeps it that
 * way until the editor moves to Tiptap 3.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Editor, getAttributesFromExtensions } from '@tiptap/core';
import { extensions } from '../ui/TiptapEditor';

/** What a hostile shared document could hold in any attribute. */
const hostile = (): unknown =>
  JSON.parse('{"__proto__": {"onerror": "globalThis.__dsk249 = 1", "data-canary": "inherited"}}');

// The editor's own resolved list: StarterKit and every other bundle flattened.
const editor = new Editor({ extensions });
const attributes = getAttributesFromExtensions(editor.extensionManager.extensions);

afterAll(() => editor.destroy());

describe('prose attribute renderers (GHSA-cp6q-959q-f8rh)', () => {
  it('finds the attributes it checks', () => {
    // Guards against a resolver change that silently checks nothing.
    expect(attributes.filter((item) => item.attribute.renderHTML).length).toBeGreaterThan(20);
  });

  it('never return an object from the document, so nothing can set their prototype', () => {
    const unsafe: string[] = [];
    for (const { type, name, attribute } of attributes) {
      if (name === '__proto__') unsafe.push(`${type}.${name} (declared name)`);
      if (!attribute.renderHTML) continue;
      const attrs = Object.fromEntries(
        attributes.filter((item) => item.type === type).map((item) => [item.name, hostile()]),
      );
      const rendered: unknown = attribute.renderHTML(attrs);
      if (rendered === null || rendered === undefined) continue;
      if (
        typeof rendered !== 'object' ||
        Object.prototype.hasOwnProperty.call(rendered, '__proto__') ||
        Object.getPrototypeOf(rendered) !== Object.prototype
      ) {
        unsafe.push(`${type}.${name}`);
      }
    }
    expect(unsafe).toEqual([]);
  });
});
