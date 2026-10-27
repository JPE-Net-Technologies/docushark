/**
 * Spelling fixes, shared by the right-click popover and the phone bar (DSK-202).
 *
 * The built-in checker marks each misspelled word with an inline decoration
 * (SpellcheckExtension). On a desktop a right-click on one opens
 * SpellcheckPopover. On a phone a long-press is the system's selection gesture,
 * so the bar offers the same fixes while the caret is in the word. Both read the
 * word from the checker's own decorations and fix it through the functions here,
 * so the two surfaces cannot drift apart.
 */

import type { Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { SpellcheckService } from '../services/SpellcheckService';
import { SPELLCHECK_PLUGIN_KEY, rebuildSpellcheck } from '../tiptap/SpellcheckExtension';
import { useRichTextStore } from '../store/richTextStore';

/** A misspelled word and its document range. */
export interface Misspelling {
  word: string;
  from: number;
  to: number;
}

/**
 * The underlined word the selection sits in, or null. A caret at either end
 * counts, since a tap on a word's last letter puts the caret after it; a range
 * selection must lie within the word.
 */
export function misspellingAtSelection(state: EditorState): Misspelling | null {
  const decorations = SPELLCHECK_PLUGIN_KEY.getState(state);
  if (!decorations) return null;
  const { from, to } = state.selection;
  const hit = decorations.find(from, to).find((d) => d.from <= from && to <= d.to);
  return hit ? { word: state.doc.textBetween(hit.from, hit.to), from: hit.from, to: hit.to } : null;
}

/** Replace a misspelled word, then re-check so its underline goes. */
export function replaceMisspelling(
  editor: Editor,
  range: { from: number; to: number },
  replacement: string,
): void {
  // Neither surface offers this to a viewer, but a permission flip can land
  // while one is open, and `insertContent` is a programmatic write that
  // `editable: false` does not block on its own.
  if (!editor.isEditable) return;
  editor.chain().focus().setTextSelection(range).insertContent(replacement).run();
  rebuildSpellcheck(editor.view);
}

/** Accept a word, for this session and in the document's dictionary. */
export function addToDictionary(editor: Editor, word: string): void {
  // Same fail-closed rule: the dictionary is document metadata a viewer has
  // no business writing.
  if (!editor.isEditable) return;
  SpellcheckService.addToSession(word);
  // Persist via the structural metadata method — never round-trip through
  // loadContent to append a word (that abused the prose content-write path
  // and once dropped the dictionary; JP-198).
  useRichTextStore.getState().addDictionaryWord(word);
  rebuildSpellcheck(editor.view);
}
