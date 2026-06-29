import { useState, useCallback, useEffect, useRef, useMemo, type CSSProperties } from 'react';
import { Search, LayoutGrid, List, Plus, X } from 'lucide-react';
import { getSelectedShapes, useSessionStore } from '../store/sessionStore';
import { useStyleProfileStore, type StyleProfile } from '../store/styleProfileStore';
import { useSettingsStore } from '../store/settingsStore';
import { clampToViewport, MENU_SIZE_ESTIMATES } from './contextMenuUtils';
import { useProfileActions } from './styleProfile/useProfileActions';
import { ProfileCard, type MenuAnchor } from './styleProfile/ProfileCard';
import './StyleProfilePanel.css';

type ViewMode = 'grid' | 'list';

interface ContextMenuState {
  pos: { x: number; y: number };
  profileId: string;
}

/** Preview swatch style for a profile (the universal dimensions). */
function getPreviewStyle(profile: StyleProfile): CSSProperties {
  return {
    backgroundColor: profile.properties.fill || 'transparent',
    borderColor: profile.properties.stroke || 'transparent',
    borderWidth: Math.min(profile.properties.strokeWidth, 3),
    borderStyle: 'solid',
    opacity: profile.properties.opacity,
    borderRadius: profile.properties.cornerRadius || 0,
  };
}

export function StyleProfilePanel() {
  const profilesRaw = useStyleProfileStore((state) => state.profiles);
  const hideDefaultStyleProfiles = useSettingsStore((state) => state.hideDefaultStyleProfiles);

  // Selection (reactive) → the shapes profiles act on.
  const selectedIds = useSessionStore((state) => state.selectedIds);
  const selectedShapes = useMemo(() => getSelectedShapes(), [selectedIds]);
  const actions = useProfileActions(selectedShapes);
  const { hasSelection, endPreview } = actions;

  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [isCreating, setIsCreating] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Sorted (favorites first) via the store's own comparator; filtered locally.
  const sorted = useMemo(() => useStyleProfileStore.getState().getSortedProfiles(), [profilesRaw]);
  const visible = useMemo(
    () =>
      sorted
        .filter((p) => !hideDefaultStyleProfiles || !p.id.startsWith('default-'))
        .filter((p) => !searchQuery || p.name.toLowerCase().includes(searchQuery.toLowerCase())),
    [sorted, hideDefaultStyleProfiles, searchQuery]
  );

  useEffect(() => {
    if (isSearching && searchInputRef.current) searchInputRef.current.focus();
  }, [isSearching]);

  // Clear any live preview when the selection changes or the panel unmounts.
  useEffect(() => endPreview, [selectedIds, endPreview]);

  const closeMenu = useCallback(() => setContextMenu(null), []);

  const openMenu = useCallback((profileId: string, anchor: MenuAnchor) => {
    const est = MENU_SIZE_ESTIMATES.medium;
    const pos = clampToViewport(anchor.x, anchor.y, est.width, est.height);
    setContextMenu({ pos, profileId });
  }, []);

  // Dismiss the context menu on outside click / Escape.
  useEffect(() => {
    if (!contextMenu) return;
    const onDown = () => closeMenu();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    const t = setTimeout(() => {
      document.addEventListener('click', onDown);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('click', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [contextMenu, closeMenu]);

  const startEditFromMenu = useCallback((profile: StyleProfile) => {
    setViewMode('list');
    setEditingId(profile.id);
    setEditingName(profile.name);
  }, []);

  const commitEdit = useCallback(() => {
    if (editingId && editingName.trim()) actions.renameProfile(editingId, editingName.trim());
    setEditingId(null);
    setEditingName('');
  }, [editingId, editingName, actions]);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditingName('');
  }, []);

  const handleSaveNew = useCallback(() => {
    actions.saveNewProfile(newProfileName);
    setNewProfileName('');
    setIsCreating(false);
  }, [actions, newProfileName]);

  const applicableHint = actions.applicableNames.length ? `Applies: ${actions.applicableNames.join(', ')}` : '';
  const titleFor = useCallback(
    (profile: StyleProfile) => {
      const parts = [profile.name];
      if (!hasSelection) parts.push('(select a shape to apply)');
      else if (applicableHint) parts.push(applicableHint);
      parts.push('Right-click for options');
      return parts.join('\n');
    },
    [hasSelection, applicableHint]
  );

  const menuProfile = contextMenu ? sorted.find((p) => p.id === contextMenu.profileId) : undefined;

  return (
    <div className="style-profile-panel">
      <div className="style-profile-header">
        <span>Style Profiles</span>
        <div className="style-profile-header-actions">
          <button
            className={`style-profile-view-btn ${isSearching || searchQuery ? 'active' : ''}`}
            onClick={() => setIsSearching((v) => !v)}
            title="Search profiles"
          >
            <Search size={15} />
          </button>
          <button
            className={`style-profile-view-btn ${viewMode === 'grid' ? 'active' : ''}`}
            onClick={() => setViewMode('grid')}
            title="Grid view"
          >
            <LayoutGrid size={15} />
          </button>
          <button
            className={`style-profile-view-btn ${viewMode === 'list' ? 'active' : ''}`}
            onClick={() => setViewMode('list')}
            title="List view"
          >
            <List size={15} />
          </button>
          {hasSelection && (
            <button
              className="style-profile-add-btn"
              onClick={() => setIsCreating(true)}
              title="Save current style as a new profile"
            >
              <Plus size={15} />
            </button>
          )}
        </div>
      </div>

      {isSearching && (
        <div className="style-profile-search">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search profiles..."
            className="style-profile-search-input"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setIsSearching(false);
                setSearchQuery('');
              }
            }}
          />
          {searchQuery && (
            <button className="style-profile-search-clear" onClick={() => setSearchQuery('')} title="Clear search">
              <X size={14} />
            </button>
          )}
        </div>
      )}

      {searchQuery && !isSearching && (
        <div className="style-profile-filter-active">
          <span>Filtered: "{searchQuery}"</span>
          <button
            className="style-profile-filter-clear"
            onClick={() => {
              setSearchQuery('');
              setIsSearching(false);
            }}
            title="Clear filter"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {isCreating && hasSelection && (
        <div className="style-profile-create">
          <input
            type="text"
            value={newProfileName}
            onChange={(e) => setNewProfileName(e.target.value)}
            placeholder="Profile name..."
            className="style-profile-input"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveNew();
              if (e.key === 'Escape') setIsCreating(false);
            }}
          />
          <div className="style-profile-create-actions">
            <button className="style-profile-btn save" onClick={handleSaveNew} disabled={!newProfileName.trim()}>
              Save
            </button>
            <button
              className="style-profile-btn cancel"
              onClick={() => {
                setIsCreating(false);
                setNewProfileName('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className={`style-profile-container ${viewMode}`}>
        {visible.map((profile) => (
          <ProfileCard
            key={profile.id}
            profile={profile}
            viewMode={viewMode}
            hasSelection={hasSelection}
            isEditing={editingId === profile.id}
            editingName={editingName}
            previewStyle={getPreviewStyle(profile)}
            titleText={titleFor(profile)}
            onApply={() => actions.applyProfile(profile)}
            onToggleFavorite={() => actions.toggleFavorite(profile.id)}
            onOpenMenu={(anchor) => openMenu(profile.id, anchor)}
            onStartEdit={() => {
              setEditingId(profile.id);
              setEditingName(profile.name);
            }}
            onEditNameChange={setEditingName}
            onCommitEdit={commitEdit}
            onCancelEdit={cancelEdit}
            onPreviewEnter={() => actions.previewProfile(profile)}
            onPreviewLeave={endPreview}
          />
        ))}
      </div>

      {!hasSelection && <div className="style-profile-hint">Select a shape to apply or save styles</div>}

      {contextMenu && menuProfile && (
        <div
          className="style-profile-context-menu"
          style={{ left: contextMenu.pos.x, top: contextMenu.pos.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {hasSelection && (
            <button
              className="style-profile-context-menu-item"
              onClick={() => {
                actions.applyProfile(menuProfile);
                closeMenu();
              }}
            >
              Apply Style
            </button>
          )}
          <button
            className="style-profile-context-menu-item"
            onClick={() => {
              actions.toggleFavorite(menuProfile.id);
              closeMenu();
            }}
          >
            {menuProfile.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
          </button>
          <button
            className="style-profile-context-menu-item"
            onClick={() => {
              actions.duplicateProfile(menuProfile);
              closeMenu();
            }}
          >
            Duplicate
          </button>
          {!menuProfile.id.startsWith('default-') && (
            <>
              <button
                className="style-profile-context-menu-item"
                onClick={() => {
                  startEditFromMenu(menuProfile);
                  closeMenu();
                }}
              >
                Rename
              </button>
              {hasSelection && (
                <button
                  className="style-profile-context-menu-item"
                  onClick={() => {
                    actions.updateProfileFromShape(menuProfile.id);
                    closeMenu();
                  }}
                >
                  Update with Current
                </button>
              )}
              {hasSelection && (
                <button
                  className="style-profile-context-menu-item"
                  onClick={() => {
                    closeMenu();
                    void actions.resetProfileFromShape(menuProfile);
                  }}
                >
                  Reset to Shape
                </button>
              )}
              <div className="style-profile-context-menu-separator" />
              <button
                className="style-profile-context-menu-item danger"
                onClick={() => {
                  closeMenu();
                  void actions.deleteProfileById(menuProfile);
                }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
