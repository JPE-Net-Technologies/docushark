import { useState, useCallback, useEffect, useRef, useLayoutEffect } from 'react';
import { useDocumentStore } from '../store/documentStore';
import { getSelectedShapes } from '../store/sessionStore';
import { useHistoryStore } from '../store/historyStore';
import {
  useStyleProfileStore,
  StyleProfile,
  extractStyleFromShape,
  getProfileUpdates,
  ExtractStyleOptions,
} from '../store/styleProfileStore';
import { useSettingsStore } from '../store/settingsStore';
import './StyleProfilePanel.css';

type ViewMode = 'grid' | 'list';

interface ContextMenuState {
  x: number;
  y: number;
  profileId: string;
}

/**
 * Panel for managing and applying style profiles.
 * Features compact grid/list views and profile management.
 */
export function StyleProfilePanel() {
  // Subscribe to profiles array directly so changes trigger re-renders
  const storeProfiles = useStyleProfileStore((state) => state.profiles);
  const addProfile = useStyleProfileStore((state) => state.addProfile);
  const updateProfile = useStyleProfileStore((state) => state.updateProfile);
  const deleteProfile = useStyleProfileStore((state) => state.deleteProfile);
  const renameProfile = useStyleProfileStore((state) => state.renameProfile);
  const toggleFavorite = useStyleProfileStore((state) => state.toggleFavorite);

  const updateShape = useDocumentStore((state) => state.updateShape);
  const push = useHistoryStore((state) => state.push);

  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [isCreating, setIsCreating] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmOverwriteId, setConfirmOverwriteId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [adjustedContextMenuPos, setAdjustedContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const hideDefaultStyleProfiles = useSettingsStore((state) => state.hideDefaultStyleProfiles);
  const saveIconStyleToProfile = useSettingsStore((state) => state.saveIconStyleToProfile);
  const saveLabelStyleToProfile = useSettingsStore((state) => state.saveLabelStyleToProfile);

  // Filter and sort profiles: optionally hide defaults, apply search, favorites first (alphabetically), then non-favorites (alphabetically)
  const profiles = [...storeProfiles]
    .filter((profile) => !hideDefaultStyleProfiles || !profile.id.startsWith('default-'))
    .filter((profile) => !searchQuery || profile.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => {
      if (a.favorite && !b.favorite) return -1;
      if (!a.favorite && b.favorite) return 1;
      return a.name.localeCompare(b.name);
    });

  // Focus search input when search opens
  useEffect(() => {
    if (isSearching && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isSearching]);

  const selectedShapes = getSelectedShapes();
  const hasSelection = selectedShapes.length > 0;
  const firstShape = selectedShapes[0];

  // Apply a profile to selected shapes
  const handleApplyProfile = useCallback(
    (profile: StyleProfile) => {
      if (selectedShapes.length === 0) return;

      push('Apply style profile');

      // The adapter translates the profile into concrete shape-field updates,
      // including a pre-merged `customProperties` for ERD entities — so there is
      // no shape-type special-casing to do here.
      for (const shape of selectedShapes) {
        updateShape(shape.id, getProfileUpdates(profile, shape));
      }
    },
    [selectedShapes, push, updateShape]
  );

  // Save current shape's style as a new profile
  const handleSaveProfile = useCallback(() => {
    if (!firstShape || !newProfileName.trim()) return;

    const extractOptions: ExtractStyleOptions = {
      includeIconStyle: saveIconStyleToProfile,
      includeLabelStyle: saveLabelStyleToProfile,
    };
    const properties = extractStyleFromShape(firstShape, extractOptions);

    addProfile(newProfileName.trim(), properties);
    setNewProfileName('');
    setIsCreating(false);
  }, [firstShape, newProfileName, addProfile, saveIconStyleToProfile, saveLabelStyleToProfile]);

  // Overwrite a profile with current shape's style
  const handleOverwriteProfile = useCallback((profileId: string) => {
    if (!firstShape) return;

    const extractOptions: ExtractStyleOptions = {
      includeIconStyle: saveIconStyleToProfile,
      includeLabelStyle: saveLabelStyleToProfile,
    };
    const properties = extractStyleFromShape(firstShape, extractOptions);

    updateProfile(profileId, { properties });
    setConfirmOverwriteId(null);
  }, [firstShape, updateProfile, saveIconStyleToProfile, saveLabelStyleToProfile]);

  // Start editing a profile name
  const handleStartEdit = useCallback((profile: StyleProfile) => {
    if (profile.id.startsWith('default-')) return;
    setEditingId(profile.id);
    setEditingName(profile.name);
  }, []);

  // Save edited name
  const handleSaveEdit = useCallback(() => {
    if (editingId && editingName.trim()) {
      renameProfile(editingId, editingName.trim());
    }
    setEditingId(null);
    setEditingName('');
  }, [editingId, editingName, renameProfile]);

  // Cancel editing
  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setEditingName('');
  }, []);

  // Request delete confirmation
  const handleRequestDelete = useCallback((id: string) => {
    setConfirmDeleteId(id);
    setConfirmOverwriteId(null);
  }, []);

  // Confirm and delete a profile
  const handleConfirmDelete = useCallback(() => {
    if (confirmDeleteId) {
      deleteProfile(confirmDeleteId);
      setConfirmDeleteId(null);
    }
  }, [confirmDeleteId, deleteProfile]);

  // Cancel delete
  const handleCancelDelete = useCallback(() => {
    setConfirmDeleteId(null);
  }, []);

  // Request overwrite confirmation
  const handleRequestOverwrite = useCallback((id: string) => {
    setConfirmOverwriteId(id);
    setConfirmDeleteId(null);
  }, []);

  // Cancel overwrite
  const handleCancelOverwrite = useCallback(() => {
    setConfirmOverwriteId(null);
  }, []);

  // Toggle favorite status
  const handleToggleFavorite = useCallback((id: string) => {
    toggleFavorite(id);
  }, [toggleFavorite]);

  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent, profileId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, profileId });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setAdjustedContextMenuPos(null);
  }, []);

  // Adjust context menu position to stay within viewport
  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) {
      setAdjustedContextMenuPos(null);
      return;
    }

    const menu = contextMenuRef.current;
    const rect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = 8;

    let newX = contextMenu.x;
    let newY = contextMenu.y;

    // Check if menu overflows right edge
    if (contextMenu.x + rect.width > viewportWidth - padding) {
      newX = Math.max(padding, viewportWidth - rect.width - padding);
    }

    // Check if menu overflows bottom edge
    if (contextMenu.y + rect.height > viewportHeight - padding) {
      newY = Math.max(padding, viewportHeight - rect.height - padding);
    }

    setAdjustedContextMenuPos({ x: newX, y: newY });
  }, [contextMenu]);

  // Close context menu on click outside or escape
  useEffect(() => {
    if (!contextMenu) return;

    const handleClick = () => closeContextMenu();
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu();
    };

    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClick);
      document.addEventListener('keydown', handleEscape);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu, closeContextMenu]);

  // Get preview style for a profile
  const getPreviewStyle = (profile: StyleProfile): React.CSSProperties => {
    return {
      backgroundColor: profile.properties.fill || 'transparent',
      borderColor: profile.properties.stroke || 'transparent',
      borderWidth: Math.min(profile.properties.strokeWidth, 3),
      borderStyle: 'solid',
      opacity: profile.properties.opacity,
      borderRadius: profile.properties.cornerRadius || 0,
    };
  };

  return (
    <div className="style-profile-panel">
      <div className="style-profile-header">
        <span>Style Profiles</span>
        <div className="style-profile-header-actions">
          {/* Search button */}
          <button
            className={`style-profile-view-btn ${isSearching || searchQuery ? 'active' : ''}`}
            onClick={() => setIsSearching(!isSearching)}
            title="Search profiles"
          >
            <SearchIcon />
          </button>
          {/* View mode toggle */}
          <button
            className={`style-profile-view-btn ${viewMode === 'grid' ? 'active' : ''}`}
            onClick={() => setViewMode('grid')}
            title="Grid view"
          >
            <GridIcon />
          </button>
          <button
            className={`style-profile-view-btn ${viewMode === 'list' ? 'active' : ''}`}
            onClick={() => setViewMode('list')}
            title="List view"
          >
            <ListIcon />
          </button>
          {hasSelection && (
            <button
              className="style-profile-add-btn"
              onClick={() => setIsCreating(true)}
              title="Save current style as profile"
            >
              <PlusIcon />
            </button>
          )}
        </div>
      </div>

      {/* Search bar */}
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
            <button
              className="style-profile-search-clear"
              onClick={() => setSearchQuery('')}
              title="Clear search"
            >
              <CloseIcon />
            </button>
          )}
        </div>
      )}

      {/* Active filter indicator */}
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
            <CloseIcon />
          </button>
        </div>
      )}

      {/* Create new profile form */}
      {isCreating && firstShape && (
        <div className="style-profile-create">
          <input
            type="text"
            value={newProfileName}
            onChange={(e) => setNewProfileName(e.target.value)}
            placeholder="Profile name..."
            className="style-profile-input"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveProfile();
              if (e.key === 'Escape') setIsCreating(false);
            }}
          />
          <div className="style-profile-create-actions">
            <button
              className="style-profile-btn save"
              onClick={handleSaveProfile}
              disabled={!newProfileName.trim()}
            >
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

      {/* Profile grid/list */}
      <div className={`style-profile-container ${viewMode}`}>
        {profiles.map((profile) => {
          const isDeleting = confirmDeleteId === profile.id;
          const isOverwriting = confirmOverwriteId === profile.id;
          const isDefault = profile.id.startsWith('default-');

          if (viewMode === 'grid') {
            return (
              <div
                key={profile.id}
                className={`style-profile-grid-item ${!hasSelection ? 'disabled' : ''} ${profile.favorite ? 'favorite' : ''}`}
                onClick={() => hasSelection && handleApplyProfile(profile)}
                onContextMenu={(e) => handleContextMenu(e, profile.id)}
                title={`${profile.name}${!hasSelection ? ' (select a shape to apply)' : ''}\nRight-click for options`}
              >
                <div
                  className="style-profile-grid-preview"
                  style={getPreviewStyle(profile)}
                />
                {profile.favorite && (
                  <span className="style-profile-grid-star">★</span>
                )}
                <span className="style-profile-grid-name">{profile.name}</span>
                {/* Confirmation overlays */}
                {isDeleting && (
                  <div className="style-profile-grid-confirm delete">
                    <span>Delete?</span>
                    <div className="style-profile-grid-confirm-actions">
                      <button onClick={(e) => { e.stopPropagation(); handleConfirmDelete(); }}>Yes</button>
                      <button onClick={(e) => { e.stopPropagation(); handleCancelDelete(); }}>No</button>
                    </div>
                  </div>
                )}
                {isOverwriting && (
                  <div className="style-profile-grid-confirm overwrite">
                    <span>Overwrite?</span>
                    <div className="style-profile-grid-confirm-actions">
                      <button onClick={(e) => { e.stopPropagation(); handleOverwriteProfile(profile.id); }}>Yes</button>
                      <button onClick={(e) => { e.stopPropagation(); handleCancelOverwrite(); }}>No</button>
                    </div>
                  </div>
                )}
              </div>
            );
          }

          // List view
          return (
            <div
              key={profile.id}
              className={`style-profile-item ${!hasSelection ? 'disabled' : ''}`}
            >
              {/* Color preview */}
              <div
                className="style-profile-preview"
                style={getPreviewStyle(profile)}
              />

              {/* Favorite star */}
              <button
                className={`style-profile-action favorite ${profile.favorite ? 'active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleFavorite(profile.id);
                }}
                title={profile.favorite ? 'Remove from favorites' : 'Add to favorites'}
              >
                <StarIcon filled={profile.favorite} />
              </button>

              {/* Name (editable for custom profiles) */}
              {editingId === profile.id ? (
                <input
                  type="text"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  className="style-profile-edit-input"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveEdit();
                    if (e.key === 'Escape') handleCancelEdit();
                  }}
                  onBlur={handleSaveEdit}
                />
              ) : (
                <span
                  className="style-profile-name"
                  onDoubleClick={() => handleStartEdit(profile)}
                  title={isDefault ? 'Built-in profile' : 'Double-click to rename'}
                >
                  {profile.name}
                </span>
              )}

              {/* Actions */}
              <div className="style-profile-actions">
                <button
                  className="style-profile-action apply"
                  onClick={() => handleApplyProfile(profile)}
                  disabled={!hasSelection}
                  title="Apply to selected shapes"
                >
                  <ApplyIcon />
                </button>
                {!isDefault && hasSelection && !isDeleting && !isOverwriting && (
                  <button
                    className="style-profile-action overwrite"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRequestOverwrite(profile.id);
                    }}
                    title="Overwrite with current style"
                  >
                    <OverwriteIcon />
                  </button>
                )}
                {!isDefault && (
                  isDeleting ? (
                    <>
                      <button
                        className="style-profile-action confirm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleConfirmDelete();
                        }}
                        title="Confirm delete"
                      >
                        <ApplyIcon />
                      </button>
                      <button
                        className="style-profile-action cancel"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCancelDelete();
                        }}
                        title="Cancel"
                      >
                        <DeleteIcon />
                      </button>
                    </>
                  ) : isOverwriting ? (
                    <>
                      <button
                        className="style-profile-action confirm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOverwriteProfile(profile.id);
                        }}
                        title="Confirm overwrite"
                      >
                        <ApplyIcon />
                      </button>
                      <button
                        className="style-profile-action cancel"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCancelOverwrite();
                        }}
                        title="Cancel"
                      >
                        <DeleteIcon />
                      </button>
                    </>
                  ) : (
                    <button
                      className="style-profile-action delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRequestDelete(profile.id);
                      }}
                      title="Delete profile"
                    >
                      <DeleteIcon />
                    </button>
                  )
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!hasSelection && (
        <div className="style-profile-hint">
          Select a shape to apply or save styles
        </div>
      )}

      {/* Context menu for grid items */}
      {contextMenu && (() => {
        const profile = profiles.find((p) => p.id === contextMenu.profileId);
        if (!profile) return null;
        const isDefault = profile.id.startsWith('default-');
        const menuPos = adjustedContextMenuPos ?? { x: contextMenu.x, y: contextMenu.y };

        return (
          <div
            ref={contextMenuRef}
            className="style-profile-context-menu"
            style={{ left: menuPos.x, top: menuPos.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {hasSelection && (
              <button
                className="style-profile-context-menu-item"
                onClick={() => {
                  handleApplyProfile(profile);
                  closeContextMenu();
                }}
              >
                Apply Style
              </button>
            )}
            <button
              className="style-profile-context-menu-item"
              onClick={() => {
                handleToggleFavorite(profile.id);
                closeContextMenu();
              }}
            >
              {profile.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
            </button>
            {!isDefault && (
              <>
                <button
                  className="style-profile-context-menu-item"
                  onClick={() => {
                    handleStartEdit(profile);
                    closeContextMenu();
                  }}
                >
                  Rename
                </button>
                {hasSelection && (
                  <button
                    className="style-profile-context-menu-item"
                    onClick={() => {
                      handleRequestOverwrite(profile.id);
                      closeContextMenu();
                    }}
                  >
                    Overwrite with Current
                  </button>
                )}
                <div className="style-profile-context-menu-separator" />
                <button
                  className="style-profile-context-menu-item danger"
                  onClick={() => {
                    handleRequestDelete(profile.id);
                    closeContextMenu();
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// SVG Icons

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M7 2v10M2 7h10" />
    </svg>
  );
}

function ApplyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 7l4 4 6-8" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 3l8 8M11 3l-8 8" />
    </svg>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M7 1l1.8 3.6 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4-2.9-2.8 4-.6L7 1z" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="1" width="5" height="5" rx="1" />
      <rect x="8" y="1" width="5" height="5" rx="1" />
      <rect x="1" y="8" width="5" height="5" rx="1" />
      <rect x="8" y="8" width="5" height="5" rx="1" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 3h9M4 7h9M4 11h9" />
      <circle cx="1.5" cy="3" r="0.75" fill="currentColor" />
      <circle cx="1.5" cy="7" r="0.75" fill="currentColor" />
      <circle cx="1.5" cy="11" r="0.75" fill="currentColor" />
    </svg>
  );
}

function OverwriteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 10v2h2l6-6-2-2-6 6z" />
      <path d="M9 3l2 2" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="6" cy="6" r="4" />
      <path d="M9 9l3 3" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 2l8 8M10 2l-8 8" />
    </svg>
  );
}
