/**
 * TagChips (JP-388) — presentational tag chips for a document card's meta row.
 *
 * Shows up to `max` chips plus a "+N" overflow counter. Each chip is a button:
 * clicking one hands the tag to `onTagClick`, which the browser wires to
 * `setSearchQuery('#' + tag)` — the chip IS the tag filter (no separate
 * filter axis). Colors are deterministic per tag (see `tagColorIndex`), so
 * the same tag reads the same everywhere with no color registry.
 */

import { tagColorIndex } from '../types/DocumentTags';
import './TagChips.css';

interface TagChipsProps {
  tags: readonly string[];
  /** Chips shown before collapsing into a "+N" counter (default 3). */
  max?: number | undefined;
  /** Click a chip to filter by it. Chips render as plain spans when absent. */
  onTagClick?: ((tag: string) => void) | undefined;
}

export function TagChips({ tags, max = 3, onTagClick }: TagChipsProps) {
  if (tags.length === 0) return null;
  const visible = tags.slice(0, max);
  const overflow = tags.length - visible.length;

  return (
    <span className="tag-chips">
      {visible.map((tag) => {
        const hue = tagColorIndex(tag);
        const style = {
          color: `var(--tag-hue-${hue})`,
          background: `var(--tag-hue-${hue}-bg)`,
        };
        return onTagClick ? (
          <button
            key={tag}
            type="button"
            className="tag-chips__chip tag-chips__chip--clickable"
            style={style}
            title={`Filter by #${tag}`}
            onClick={(e) => {
              e.stopPropagation();
              onTagClick(tag);
            }}
          >
            {tag}
          </button>
        ) : (
          <span key={tag} className="tag-chips__chip" style={style} title={tag}>
            {tag}
          </span>
        );
      })}
      {overflow > 0 && (
        <span className="tag-chips__more" title={tags.slice(max).join(', ')}>
          +{overflow}
        </span>
      )}
    </span>
  );
}

export default TagChips;
