import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import { SpellcheckService } from '../services/SpellcheckService';
import { addToDictionary, replaceMisspelling } from './proseSpelling';

export interface SpellcheckPopoverProps {
  editor: Editor;
  word: string;
  /** Document positions of the misspelled word (from..to) */
  range: { from: number; to: number };
  x: number;
  y: number;
  onClose: () => void;
}

export function SpellcheckPopover({ editor, word, range, x, y, onClose }: SpellcheckPopoverProps) {
  const [suggestions, setSuggestions] = useState<string[]>(() => SpellcheckService.suggest(word));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDocClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.spellcheck-popover')) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDocClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDocClick);
    };
  }, [onClose]);

  useEffect(() => {
    setSuggestions(SpellcheckService.suggest(word));
  }, [word]);

  // The fixes themselves are shared with the phone bar (proseSpelling), which
  // also keeps them fail-closed on a surface that has turned read-only.
  const replaceWith = (replacement: string) => {
    replaceMisspelling(editor, range, replacement);
    onClose();
  };

  const acceptWord = () => {
    addToDictionary(editor, word);
    onClose();
  };

  return createPortal(
    <div
      className="spellcheck-popover"
      style={{
        position: 'fixed',
        left: x,
        top: y,
        zIndex: 10000,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="spellcheck-popover-header">{word}</div>
      {suggestions.length === 0 ? (
        <div className="spellcheck-popover-empty">No suggestions</div>
      ) : (
        <ul className="spellcheck-popover-list">
          {suggestions.map((s) => (
            <li key={s}>
              <button onClick={() => replaceWith(s)}>{s}</button>
            </li>
          ))}
        </ul>
      )}
      <div className="spellcheck-popover-divider" />
      <button className="spellcheck-popover-add" onClick={acceptWord}>
        Add to Dictionary
      </button>
    </div>,
    document.body,
  );
}
