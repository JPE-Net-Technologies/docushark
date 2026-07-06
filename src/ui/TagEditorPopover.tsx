/**
 * TagEditorPopover (JP-388) — a small anchored editor for a document's tags.
 *
 * Text input (Enter adds), current tags as removable chips, and a suggestion
 * listbox drawn from the tags already used across the library (filtered by
 * the input). A plain listbox, not <datalist> — WebKitGTK styles datalists
 * poorly. Commits through `onCommit` on every change (the caller persists);
 * input is normalized by `normalizeTags` at that seam.
 *
 * Positioning: fixed panel anchored under the given rect, viewport-clamped —
 * same approach as DropdownMenu, kept local because this panel is focus-holding
 * (an input), not a menu.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { MAX_TAGS_PER_DOC, normalizeTags, tagColorIndex } from '../types/DocumentTags';
import './TagEditorPopover.css';

interface TagEditorPopoverProps {
  /** Current tags (already normalized — they came from the doc). */
  tags: readonly string[];
  /** Union of tags across the library, for suggestions (own tags filtered out here). */
  suggestions: readonly string[];
  /** Anchor rect (viewport coords) the panel opens under. */
  anchor: { top: number; bottom: number; left: number; right: number };
  /** Called with the full normalized next list on every add/remove. */
  onCommit: (next: string[]) => void;
  onClose: () => void;
}

const PANEL_WIDTH = 260;

export function TagEditorPopover({
  tags,
  suggestions,
  anchor,
  onCommit,
  onClose,
}: TagEditorPopoverProps) {
  const [input, setInput] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on outside mousedown or Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    const timeoutId = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const addTag = useCallback(
    (raw: string) => {
      const next = normalizeTags([...tags, raw]);
      setInput('');
      if (next.length !== tags.length || raw.trim()) onCommit(next);
    },
    [tags, onCommit],
  );

  const removeTag = useCallback(
    (tag: string) => {
      onCommit(tags.filter((t) => t !== tag));
    },
    [tags, onCommit],
  );

  const filteredSuggestions = useMemo(() => {
    const own = new Set(tags.map((t) => t.toLowerCase()));
    const q = input.trim().toLowerCase();
    return suggestions
      .filter((s) => !own.has(s.toLowerCase()))
      .filter((s) => (q ? s.toLowerCase().includes(q) : true))
      .slice(0, 6);
  }, [suggestions, tags, input]);

  const atCap = tags.length >= MAX_TAGS_PER_DOC;

  // Viewport-clamped position under the anchor (flips above when tight).
  const left = Math.max(8, Math.min(anchor.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8));
  const estimatedHeight = 220;
  const top =
    anchor.bottom + 4 + estimatedHeight > window.innerHeight - 8
      ? Math.max(8, anchor.top - 4 - estimatedHeight)
      : anchor.bottom + 4;

  return createPortal(
    <div
      ref={panelRef}
      className="tag-editor"
      role="dialog"
      aria-label="Edit tags"
      style={{ top, left, width: PANEL_WIDTH }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="tag-editor__chips">
        {tags.length === 0 && <span className="tag-editor__empty">No tags yet</span>}
        {tags.map((tag) => {
          const hue = tagColorIndex(tag);
          return (
            <span
              key={tag}
              className="tag-editor__chip"
              style={{ color: `var(--tag-hue-${hue})`, background: `var(--tag-hue-${hue}-bg)` }}
            >
              {tag}
              <button
                type="button"
                className="tag-editor__remove"
                aria-label={`Remove tag ${tag}`}
                onClick={() => removeTag(tag)}
              >
                <X size={11} aria-hidden="true" />
              </button>
            </span>
          );
        })}
      </div>
      <input
        ref={inputRef}
        type="text"
        className="tag-editor__input"
        placeholder={atCap ? `Tag limit reached (${MAX_TAGS_PER_DOC})` : 'Add a tag…'}
        value={input}
        disabled={atCap}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && input.trim()) {
            e.preventDefault();
            addTag(input);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      />
      {filteredSuggestions.length > 0 && !atCap && (
        <div className="tag-editor__suggestions" role="listbox" aria-label="Tag suggestions">
          {filteredSuggestions.map((s) => (
            <button
              key={s}
              type="button"
              role="option"
              aria-selected="false"
              className="tag-editor__suggestion"
              onClick={() => addTag(s)}
            >
              <span
                className="tag-editor__suggestion-dot"
                style={{ background: `var(--tag-hue-${tagColorIndex(s)})` }}
              />
              {s}
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

export default TagEditorPopover;
