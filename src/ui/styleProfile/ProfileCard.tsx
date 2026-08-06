/**
 * A single style-profile card, shared by the grid and list views.
 *
 * Click applies; hover previews live on the canvas; the action rail (hover or
 * keyboard focus) carries the per-profile actions.
 *
 * Three things here are deliberate rather than incidental:
 *
 * 1. **The card is a real `<button>`.** It used to be a `<div onClick>` with no
 *    role and `tabIndex: -1`, which made the entire panel unreachable by
 *    keyboard — profiles could be applied only with a mouse.
 * 2. **The swatch is rendered by the real shape handlers** (`profilePreview`),
 *    not approximated in CSS from four profile keys. See that module for why.
 * 3. **The action rail expands on `:focus-within` as well as `:hover`**, so the
 *    keyboard path reaches the same actions the mouse does instead of a
 *    hover-only dead end.
 */

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { Star, MoreHorizontal, Cloud, RefreshCw } from 'lucide-react';
import type { StyleProfile } from '../../store/styleProfileStore';
import { renderProfileSwatch } from './profilePreview';
import { getStudioCoverage } from './studio/coverage';

export interface MenuAnchor {
  x: number;
  y: number;
}

const SYNCED_TITLE = 'Synced to this workspace';

/** Swatch edge length in CSS pixels, per view. Fixed so the grid can pin its
 *  row height — a swatch that sized itself to content is half of what made the
 *  grid ragged in the first place. The grid swatch is deliberately smaller than
 *  the space it used to claim: the card now splits its height between the
 *  preview and a two-line name, rather than giving nearly all of it to a
 *  swatch and leaving the name a truncated sliver. */
const SWATCH_SIZE = { grid: 40, list: 20 } as const;

interface ProfileCardProps {
  profile: StyleProfile;
  viewMode: 'grid' | 'list';
  hasSelection: boolean;
  isEditing: boolean;
  editingName: string;
  /** CSS fallback used when the shape registry can't draw this profile. */
  previewStyle: CSSProperties;
  /** Tooltip describing what applying this profile affects on the selection. */
  titleText: string;
  onApply: () => void;
  onToggleFavorite: () => void;
  onOpenMenu: (anchor: MenuAnchor) => void;
  onStartEdit: () => void;
  onEditNameChange: (value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onPreviewEnter: () => void;
  onPreviewLeave: () => void;
  /** Merge the current selection's style into this profile. Absent = unavailable. */
  onUpdateFromShape?: (() => void) | undefined;
}

/**
 * Canvas swatch drawn by the registered shape handler. Falls back to the CSS
 * approximation when the handler can't draw (unregistered type, or no 2D
 * context — jsdom in tests), so a card is never a blank hole.
 */
function ProfileSwatch({
  profile,
  size,
  fallbackStyle,
  className,
}: {
  profile: StyleProfile;
  size: number;
  fallbackStyle: CSSProperties;
  className: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [drawn, setDrawn] = useState(true);

  // Redraw whenever the profile's visual content changes — a profile edited via
  // "Update with current" must not keep showing its old look.
  const propsKey = JSON.stringify(profile.properties);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setDrawn(renderProfileSwatch(canvas, profile, { size }));
    // `propsKey` is the dependency that matters; profile identity is unstable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propsKey, size]);

  if (!drawn) {
    return <div className={className} style={fallbackStyle} aria-hidden="true" />;
  }
  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

export function ProfileCard(props: ProfileCardProps) {
  const {
    profile, viewMode, hasSelection, isEditing, editingName, previewStyle, titleText,
    onApply, onToggleFavorite, onOpenMenu, onStartEdit, onEditNameChange,
    onCommitEdit, onCancelEdit, onPreviewEnter, onPreviewLeave, onUpdateFromShape,
  } = props;

  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onOpenMenu({ x: e.clientX, y: e.clientY });
  };

  const handleMenuButton = (e: MouseEvent) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    onOpenMenu({ x: rect.left, y: rect.bottom });
  };

  const apply = () => {
    if (hasSelection) onApply();
  };

  /** Workspace-scoped profiles carry a quiet marker so it's obvious at a glance
   *  which styles follow you between devices and which are local to this one. */
  const synced = profile.scope === 'workspace';
  const isBuiltIn = profile.id.startsWith('default-');

  /* How many shape families this profile has actually been taught about, beyond
     the universal fill/stroke. This is the breadth the swatch alone can never
     show: a profile tuned across swimlanes and ERD entities looks identical to
     a bare one until you say so. */
  const coverage = getStudioCoverage(profile);
  const coverageTitle = `Tuned for ${coverage.saved} of ${coverage.reachable} shape sets`;

  /**
   * The action rail. Favorite and (when a shape is selected) Update-with-current
   * are the two actions frequent enough to earn a permanent slot; everything
   * else stays behind the overflow menu. Each button stops propagation so
   * pressing one never also applies the profile.
   *
   * The buttons are `tabIndex={-1}`: the card itself is the tab stop, and the
   * rail is reachable from it. Putting three extra stops on every card would
   * make tabbing through a panel of twenty profiles punishing.
   */
  const rail = (
    <div className="style-profile-rail">
      <button
        className={`style-profile-action favorite ${profile.favorite ? 'active' : ''}`}
        onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
        title={profile.favorite ? 'Remove from favorites' : 'Add to favorites'}
        aria-label={profile.favorite ? `Remove ${profile.name} from favorites` : `Add ${profile.name} to favorites`}
        aria-pressed={profile.favorite}
        tabIndex={-1}
      >
        <Star size={14} fill={profile.favorite ? 'currentColor' : 'none'} />
      </button>
      {onUpdateFromShape && !isBuiltIn && (
        <button
          className="style-profile-action"
          onClick={(e) => { e.stopPropagation(); onUpdateFromShape(); }}
          title="Update with current style"
          aria-label={`Update ${profile.name} with the current style`}
          tabIndex={-1}
        >
          <RefreshCw size={14} />
        </button>
      )}
      <button
        className="style-profile-action menu"
        onClick={handleMenuButton}
        title="More options"
        aria-label={`More options for ${profile.name}`}
        tabIndex={-1}
      >
        <MoreHorizontal size={14} />
      </button>
    </div>
  );

  if (viewMode === 'grid') {
    return (
      <div
        className={`style-profile-grid-item ${!hasSelection ? 'disabled' : ''} ${profile.favorite ? 'favorite' : ''}`}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => hasSelection && onPreviewEnter()}
        onMouseLeave={onPreviewLeave}
      >
        <button
          type="button"
          className="style-profile-grid-apply"
          onClick={apply}
          onFocus={() => hasSelection && onPreviewEnter()}
          onBlur={onPreviewLeave}
          title={titleText}
          aria-label={titleText}
          // Deliberately `aria-disabled`, not `disabled`. A real `disabled`
          // button drops out of the tab order, which would put the action rail
          // (favorite / rename / delete — none of which need a selection)
          // permanently out of keyboard reach whenever nothing is selected.
          // That is the same dead end this card rework exists to remove.
          aria-disabled={!hasSelection}
        >
          <ProfileSwatch
            profile={profile}
            size={SWATCH_SIZE.grid}
            fallbackStyle={previewStyle}
            className="style-profile-grid-preview"
          />
          <span className="style-profile-grid-name">{profile.name}</span>
          {coverage.saved > 0 && (
            <span
              className="style-profile-coverage"
              title={coverageTitle}
              aria-hidden="true"
            >
              {coverage.saved} tuned
            </span>
          )}
        </button>
        {profile.favorite && <span className="style-profile-grid-star" aria-hidden="true">★</span>}
        {synced && (
          <span className="style-profile-synced" title={SYNCED_TITLE} aria-hidden="true">
            <Cloud size={11} />
          </span>
        )}
        {rail}
      </div>
    );
  }

  return (
    <div
      className={`style-profile-item ${!hasSelection ? 'disabled' : ''}`}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => hasSelection && onPreviewEnter()}
      onMouseLeave={onPreviewLeave}
    >
      <button
        type="button"
        className="style-profile-apply"
        onClick={apply}
        onFocus={() => hasSelection && onPreviewEnter()}
        onBlur={onPreviewLeave}
        title={hasSelection ? `Apply ${profile.name} to selection` : titleText}
        aria-label={hasSelection ? `Apply ${profile.name} to selection` : titleText}
        aria-disabled={!hasSelection}
      >
        <ProfileSwatch
          profile={profile}
          size={SWATCH_SIZE.list}
          fallbackStyle={previewStyle}
          className="style-profile-preview"
        />
      </button>

      {isEditing ? (
        <input
          type="text"
          value={editingName}
          onChange={(e) => onEditNameChange(e.target.value)}
          className="style-profile-edit-input"
          aria-label={`Rename ${profile.name}`}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommitEdit();
            if (e.key === 'Escape') onCancelEdit();
          }}
          onBlur={onCommitEdit}
        />
      ) : (
        <span
          className="style-profile-name"
          onDoubleClick={onStartEdit}
          title={profile.name}
        >
          {profile.name}
        </span>
      )}

      {synced && (
        <span className="style-profile-synced" title={SYNCED_TITLE} aria-hidden="true">
          <Cloud size={12} />
        </span>
      )}

      {rail}
    </div>
  );
}
