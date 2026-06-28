/**
 * A single style-profile card, shared by the grid and list views (collapsing
 * what used to be two near-duplicate renderings). Click applies; hover previews
 * live on the canvas; the ⋯ button / right-click opens the actions menu.
 */

import type { CSSProperties, MouseEvent } from 'react';
import { Star, MoreHorizontal } from 'lucide-react';
import type { StyleProfile } from '../../store/styleProfileStore';

export interface MenuAnchor {
  x: number;
  y: number;
}

interface ProfileCardProps {
  profile: StyleProfile;
  viewMode: 'grid' | 'list';
  hasSelection: boolean;
  isEditing: boolean;
  editingName: string;
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
}

export function ProfileCard(props: ProfileCardProps) {
  const {
    profile, viewMode, hasSelection, isEditing, editingName, previewStyle, titleText,
    onApply, onToggleFavorite, onOpenMenu, onStartEdit, onEditNameChange,
    onCommitEdit, onCancelEdit, onPreviewEnter, onPreviewLeave,
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

  if (viewMode === 'grid') {
    return (
      <div
        className={`style-profile-grid-item ${!hasSelection ? 'disabled' : ''} ${profile.favorite ? 'favorite' : ''}`}
        onClick={apply}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => hasSelection && onPreviewEnter()}
        onMouseLeave={onPreviewLeave}
        title={titleText}
      >
        <div className="style-profile-grid-preview" style={previewStyle} />
        {profile.favorite && <span className="style-profile-grid-star">★</span>}
        <span className="style-profile-grid-name">{profile.name}</span>
        <button
          className="style-profile-grid-menu"
          onClick={handleMenuButton}
          title="More options"
          aria-label="More options"
        >
          <MoreHorizontal size={14} />
        </button>
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
      <div
        className="style-profile-preview"
        style={previewStyle}
        onClick={apply}
        role="button"
        title={hasSelection ? 'Apply to selection' : titleText}
      />

      <button
        className={`style-profile-action favorite ${profile.favorite ? 'active' : ''}`}
        onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
        title={profile.favorite ? 'Remove from favorites' : 'Add to favorites'}
      >
        <Star size={15} fill={profile.favorite ? 'currentColor' : 'none'} />
      </button>

      {isEditing ? (
        <input
          type="text"
          value={editingName}
          onChange={(e) => onEditNameChange(e.target.value)}
          className="style-profile-edit-input"
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
          title={titleText}
        >
          {profile.name}
        </span>
      )}

      <div className="style-profile-actions">
        <button
          className="style-profile-action menu"
          onClick={handleMenuButton}
          title="More options"
          aria-label="More options"
        >
          <MoreHorizontal size={15} />
        </button>
      </div>
    </div>
  );
}
