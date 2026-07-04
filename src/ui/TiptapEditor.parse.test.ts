/**
 * JP-428 field repro: parse the exact relay-served version-history HTML with
 * the REAL local-editor extension list (not a minimal subset) and assert
 * nothing after the first paragraph is dropped.
 */
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { extensions } from './TiptapEditor';

const SERVED_HTML =
  '<p>Hello</p><h1>My Gallery</h1><p>Welcome.</p>' +
  '<div data-gallery data-layout="grid"><div class="gallery-items">' +
  '<img src="blob://680e63319c0de1f2b3a2b58596db2d85fb88cbb2e5375bb042cd9233a430a78c" alt="JNT-Logo-v1.png" width="220">' +
  '<img src="blob://4b9214df4f73b5e4c6d54ccf715bf18b9ccbb7aed6b3f4b875071c1bf0f95c7c" alt="Blackcache-Origin.png" width="220">' +
  '</div></div>' +
  '<h1>Heading After Gallery</h1><p>Welcome, again.</p>';

describe('local editor parse of relay-served prose', () => {
  it('keeps the gallery and all content after it (setContent path)', () => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    const editor = new Editor({ element, extensions, content: '<p></p>' });
    editor.commands.setContent(SERVED_HTML);

    const html = editor.getHTML();
    expect(html).toContain('My Gallery');
    expect(html).toContain('data-gallery');
    expect(html).toContain('blob://680e63319');
    expect(html).toContain('Heading After Gallery');
    expect(html).toContain('Welcome, again.');

    editor.destroy();
    element.remove();
  });
});
