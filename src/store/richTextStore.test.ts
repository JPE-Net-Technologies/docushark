import { describe, it, expect, beforeEach } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { useRichTextStore } from './richTextStore';
import { RICH_TEXT_VERSION } from '../types/RichText';

describe('richTextStore.setContent — preserves sibling content fields (JP-173)', () => {
  beforeEach(() => {
    useRichTextStore.getState().reset();
  });

  it('keeps customDictionary when an editor update calls setContent', () => {
    // A document loads with a custom dictionary (words 'Added to Dictionary').
    useRichTextStore.getState().loadContent({
      content: { type: 'doc', content: [] },
      version: RICH_TEXT_VERSION,
      customDictionary: ['Tiptap', 'Yjs'],
    });

    // An editor `onUpdate` carries only the Tiptap JSON.
    const edited: JSONContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
    };
    useRichTextStore.getState().setContent(edited);

    const { content } = useRichTextStore.getState();
    expect(content.content).toEqual(edited);
    // The dictionary must survive the keystroke (was previously wiped).
    expect(content.customDictionary).toEqual(['Tiptap', 'Yjs']);
    expect(content.version).toBe(RICH_TEXT_VERSION);
  });

  it('does not invent a customDictionary when there was none', () => {
    useRichTextStore.getState().setContent({ type: 'doc', content: [] });
    expect(useRichTextStore.getState().content.customDictionary).toBeUndefined();
  });
});
