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

describe('richTextStore.setContentSilently — projection writes never dirty (JP-89)', () => {
  beforeEach(() => {
    useRichTextStore.getState().reset();
  });

  const doc = (text: string): JSONContent => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

  it('updates content without setting isDirty', () => {
    expect(useRichTextStore.getState().isDirty).toBe(false);
    useRichTextStore.getState().setContentSilently(doc('projected'));
    const s = useRichTextStore.getState();
    expect(s.content.content).toEqual(doc('projected'));
    expect(s.isDirty).toBe(false); // derived write must not dirty
  });

  it('preserves the dirty edge for a following real edit (no swallowed autosave)', () => {
    // The trap: if a silent update latched isDirty, the next real edit would
    // produce no false→true edge and never schedule an autosave.
    useRichTextStore.getState().setContentSilently(doc('projected'));
    expect(useRichTextStore.getState().isDirty).toBe(false);

    // Observe the edge a real edit produces.
    let sawRisingEdge = false;
    const unsub = useRichTextStore.subscribe((state, prev) => {
      if (state.isDirty && !prev.isDirty) sawRisingEdge = true;
    });
    useRichTextStore.getState().setContent(doc('user edit'));
    unsub();

    expect(sawRisingEdge).toBe(true);
    expect(useRichTextStore.getState().isDirty).toBe(true);
  });

  it('preserves sibling content fields (e.g. customDictionary)', () => {
    useRichTextStore.getState().loadContent({
      content: { type: 'doc', content: [] },
      version: RICH_TEXT_VERSION,
      customDictionary: ['Yjs'],
    });
    useRichTextStore.getState().setContentSilently(doc('projected'));
    expect(useRichTextStore.getState().content.customDictionary).toEqual(['Yjs']);
  });
});
