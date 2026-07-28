/**
 * PdfFindBar — text search over the PDFFindController. Live search debounced
 * while typing; Enter advances, Shift+Enter goes back. Match counts and the
 * not-found state come from the controller (updatefindmatchescount /
 * updatefindcontrolstate events).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { Icon } from '../../icons';
import type { PdfViewerController } from './usePdfViewerController';

const LIVE_SEARCH_DEBOUNCE_MS = 250;

export interface PdfFindBarProps {
  controller: PdfViewerController;
  onClose: () => void;
}

export function PdfFindBar({ controller, onClose }: PdfFindBarProps) {
  const [query, setQuery] = useState('');
  const [highlightAll, setHighlightAll] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Live search while typing (also re-runs when highlight-all flips).
  useEffect(() => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    if (query === '') return undefined;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      controller.find({ query, highlightAll });
    }, LIVE_SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [query, highlightAll, controller]);

  const findNext = useCallback(() => {
    if (query === '') return;
    controller.find({ query, highlightAll, again: true });
  }, [query, highlightAll, controller]);

  const findPrevious = useCallback(() => {
    if (query === '') return;
    controller.find({ query, highlightAll, again: true, previous: true });
  }, [query, highlightAll, controller]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) findPrevious();
        else findNext();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    },
    [findNext, findPrevious, onClose],
  );

  const { findMatches, findNotFound } = controller;

  return (
    <div className="pdf-reader__findbar" role="search">
      <input
        ref={inputRef}
        className={`pdf-reader__find-input${findNotFound ? ' pdf-reader__find-input--notfound' : ''}`}
        type="text"
        placeholder="Find in document…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        aria-label="Find in document"
      />
      <span className="pdf-reader__find-count" aria-live="polite">
        {findNotFound
          ? 'Not found'
          : findMatches && findMatches.total > 0
            ? `${findMatches.current} / ${findMatches.total}`
            : ''}
      </span>
      <button
        className="pdf-reader__btn"
        onClick={findPrevious}
        disabled={query === ''}
        title="Previous match (Shift+Enter)"
      >
        <Icon icon={ChevronUp} size={16} />
      </button>
      <button
        className="pdf-reader__btn"
        onClick={findNext}
        disabled={query === ''}
        title="Next match (Enter)"
      >
        <Icon icon={ChevronDown} size={16} />
      </button>
      <label className="pdf-reader__find-highlight">
        <input
          type="checkbox"
          checked={highlightAll}
          onChange={(e) => setHighlightAll(e.target.checked)}
        />
        Highlight all
      </label>
      <button
        className="pdf-reader__btn pdf-reader__find-close"
        onClick={onClose}
        title="Close find (Escape)"
      >
        <Icon icon={X} size={16} />
      </button>
    </div>
  );
}
