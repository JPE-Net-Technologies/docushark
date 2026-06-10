/**
 * Tests for the prose-projection transaction marker (JP-89).
 */
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { PROSE_PROJECTION_META, isProjectionTransaction } from './proseProjection';

function makeEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({ element, extensions: [StarterKit.configure({ history: false })], content: '<p>x</p>' });
}

describe('isProjectionTransaction', () => {
  it('is false for an ordinary transaction', () => {
    const editor = makeEditor();
    expect(isProjectionTransaction(editor.state.tr)).toBe(false);
    editor.destroy();
  });

  it('is true once tagged with PROSE_PROJECTION_META', () => {
    const editor = makeEditor();
    const tr = editor.state.tr.setMeta(PROSE_PROJECTION_META, true);
    expect(isProjectionTransaction(tr)).toBe(true);
    editor.destroy();
  });
});
