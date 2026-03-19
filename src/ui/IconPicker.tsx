/**
 * IconPicker - Component for selecting icons from the icon library.
 *
 * Features:
 * - Browse built-in and custom icons
 * - Category filtering
 * - Search functionality
 * - Upload custom SVG icons
 * - Preview selected icon
 * - Portal-based dropdown to avoid overflow clipping
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useIconLibraryStore, initializeIconLibrary } from '../store/iconLibraryStore';
import type { IconMetadata, IconCategory } from '../storage/IconTypes';
import { ICON_CATEGORY_LABELS, LAZY_ICON_CATEGORIES } from '../storage/IconTypes';
import { getIconCategories, isLazyCategory, isCategoryLoaded } from '../storage/builtinIcons';
import './IconPicker.css';

/**
 * Props for the IconPicker component.
 */
interface IconPickerProps {
  /** Currently selected icon ID */
  value: string | undefined;
  /** Callback when icon changes */
  onChange: (iconId: string | undefined) => void;
  /** Label for the picker */
  label?: string;
}

/** Core categories to show by default (eagerly loaded) */
const CORE_CATEGORIES: IconCategory[] = ['arrows', 'shapes', 'symbols', 'tech', 'general'];

/**
 * IconPicker component.
 */
export function IconPicker({ value, onChange, label = 'Icon' }: IconPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<IconCategory | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isInitialized, setIsInitialized] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    getAllIcons,
    uploadIcon,
    customIcons,
    isLoading,
    error,
    clearError,
    loadCategory,
    isCategoryLoading,
    getIconsByCategory,
    loadedCategories,
    loadingCategories,
  } = useIconLibraryStore();

  // Initialize icon library on mount
  useEffect(() => {
    if (!isInitialized) {
      initializeIconLibrary().then(() => setIsInitialized(true));
    }
  }, [isInitialized]);

  // Get all icons — recompute when custom icons or lazy categories change
  const allIcons = useMemo(() => getAllIcons(), [customIcons, loadedCategories]);

  // Get categories with counts - organized by type
  const categories = useMemo(() => {
    const builtinCategories = getIconCategories();
    const customCount = customIcons.length;

    // Separate core and lazy categories
    const coreCategories = builtinCategories.filter((c) => CORE_CATEGORIES.includes(c.category));
    const lazyCategories = builtinCategories.filter((c) => c.lazy);

    return {
      all: { category: 'all' as const, count: allIcons.length, lazy: false },
      core: coreCategories,
      lazy: lazyCategories,
      custom: customCount > 0 ? { category: 'custom' as IconCategory, count: customCount, lazy: false } : null,
    };
  }, [allIcons.length, customIcons.length, loadedCategories]);

  // Load lazy category when selected
  useEffect(() => {
    if (selectedCategory !== 'all' && isLazyCategory(selectedCategory)) {
      loadCategory(selectedCategory);
    }
  }, [selectedCategory, loadCategory]);

  // Preload all lazy categories when picker opens (via store for loading state tracking)
  useEffect(() => {
    if (isOpen) {
      for (const category of LAZY_ICON_CATEGORIES) {
        loadCategory(category);
      }
    }
  }, [isOpen, loadCategory]);

  // Filter icons by category and search
  const filteredIcons = useMemo(() => {
    let icons: IconMetadata[];

    // Get icons based on category selection
    if (selectedCategory === 'all') {
      icons = allIcons;
    } else {
      icons = getIconsByCategory(selectedCategory);
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      icons = icons.filter((icon) => icon.name.toLowerCase().includes(query));
    }

    return icons;
  }, [allIcons, selectedCategory, searchQuery, getIconsByCategory, loadedCategories]);

  // Check if current category is loading
  const isCategoryLoadingNow = selectedCategory !== 'all' && isCategoryLoading(selectedCategory);
  // Check if lazy categories are still loading in background (for "all" tab indicator)
  const hasLoadingCategories = loadingCategories.length > 0;

  // Get selected icon details
  const selectedIcon = useMemo(() => {
    if (!value) return undefined;
    return useIconLibraryStore.getState().getIcon(value);
  }, [value]);

  // Calculate dropdown position when opening
  const updateDropdownPosition = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
      });
    }
  }, []);

  // Toggle dropdown and update position
  const handleToggle = useCallback(() => {
    if (!isOpen) {
      updateDropdownPosition();
    }
    setIsOpen(!isOpen);
  }, [isOpen, updateDropdownPosition]);

  // Close picker when clicking outside (check both container and portal dropdown)
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const dropdown = document.querySelector('.icon-picker-dropdown-portal');

      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        (!dropdown || !dropdown.contains(target))
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Update position on scroll/resize
  useEffect(() => {
    if (!isOpen) return;

    const handleUpdate = () => updateDropdownPosition();
    window.addEventListener('scroll', handleUpdate, true);
    window.addEventListener('resize', handleUpdate);

    return () => {
      window.removeEventListener('scroll', handleUpdate, true);
      window.removeEventListener('resize', handleUpdate);
    };
  }, [isOpen, updateDropdownPosition]);

  // Handle icon selection
  const handleSelect = useCallback(
    (icon: IconMetadata) => {
      onChange(icon.id);
      setIsOpen(false);
    },
    [onChange]
  );

  // Handle clear selection
  const handleClear = useCallback(() => {
    onChange(undefined);
    setIsOpen(false);
  }, [onChange]);

  // Handle file upload
  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const result = await uploadIcon(file);
      if (result.success && result.icon) {
        onChange(result.icon.id);
        setIsOpen(false);
      }

      // Reset file input
      e.target.value = '';
    },
    [uploadIcon, onChange]
  );

  // Clear error on open
  useEffect(() => {
    if (isOpen) {
      clearError();
    }
  }, [isOpen, clearError]);

  // Render the dropdown content
  const dropdownContent = isOpen && dropdownPosition && (
    <div
      className="icon-picker-dropdown icon-picker-dropdown-portal"
      style={{
        position: 'fixed',
        top: dropdownPosition.top,
        left: dropdownPosition.left,
        width: dropdownPosition.width,
        zIndex: 10000,
      }}
    >
      {/* Search and Upload */}
      <div className="icon-picker-header">
        <input
          type="text"
          className="icon-picker-search"
          placeholder="Search icons..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          autoFocus
        />
        <button
          className="icon-picker-upload-btn"
          onClick={handleUploadClick}
          title="Upload custom SVG icon"
        >
          +
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".svg,image/svg+xml"
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />
      </div>

      {/* Category tabs */}
      <div className="icon-picker-categories">
        {/* All category */}
        <button
          className={`icon-picker-category ${selectedCategory === 'all' ? 'active' : ''}`}
          onClick={() => setSelectedCategory('all')}
        >
          All ({categories.all.count})
        </button>

        {/* Core categories */}
        {categories.core.map(({ category, count }) => (
          <button
            key={category}
            className={`icon-picker-category ${selectedCategory === category ? 'active' : ''}`}
            onClick={() => setSelectedCategory(category)}
          >
            {ICON_CATEGORY_LABELS[category]} ({count})
          </button>
        ))}

        {/* Separator if there are lazy categories */}
        {categories.lazy.length > 0 && <span className="icon-picker-category-sep">|</span>}

        {/* Lazy-loadable categories (cloud, devops, etc.) */}
        {categories.lazy.map(({ category, count }) => {
          const loaded = isCategoryLoaded(category);
          return (
            <button
              key={category}
              className={`icon-picker-category ${selectedCategory === category ? 'active' : ''} ${!loaded ? 'lazy' : ''}`}
              onClick={() => setSelectedCategory(category)}
              title={!loaded ? 'Click to load' : undefined}
            >
              {ICON_CATEGORY_LABELS[category]} {loaded ? `(${count})` : ''}
            </button>
          );
        })}

        {/* Custom category if has items */}
        {categories.custom && (
          <button
            className={`icon-picker-category ${selectedCategory === 'custom' ? 'active' : ''}`}
            onClick={() => setSelectedCategory('custom')}
          >
            Custom ({categories.custom.count})
          </button>
        )}
      </div>

      {/* Error display */}
      {error && <div className="icon-picker-error">{error}</div>}

      {/* Icons grid */}
      <div className="icon-picker-grid">
        {/* Clear option */}
        {value && (
          <button
            className="icon-picker-item icon-picker-clear"
            onClick={handleClear}
            title="Remove icon"
          >
            <span className="icon-picker-clear-icon">{'\u2715'}</span>
            <span className="icon-picker-item-name">None</span>
          </button>
        )}

        {isLoading || isCategoryLoadingNow ? (
          <div className="icon-picker-loading">Loading icons…</div>
        ) : filteredIcons.length === 0 && !hasLoadingCategories ? (
          <div className="icon-picker-empty">No icons found</div>
        ) : (
          <>
            {filteredIcons.map((icon) => (
              <button
                key={icon.id}
                className={`icon-picker-item ${value === icon.id ? 'selected' : ''}`}
                onClick={() => handleSelect(icon)}
                title={icon.name}
              >
                <IconPreview icon={icon} size={24} />
                <span className="icon-picker-item-name">{icon.name}</span>
              </button>
            ))}
            {hasLoadingCategories && (
              <div className="icon-picker-loading">Loading icons…</div>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="icon-picker" ref={containerRef}>
      <label className="icon-picker-label">{label}</label>

      <div className="icon-picker-trigger" ref={triggerRef} onClick={handleToggle}>
        {selectedIcon ? (
          <div className="icon-picker-preview">
            <IconPreview icon={selectedIcon} size={20} />
            <span className="icon-picker-name">{selectedIcon.name}</span>
          </div>
        ) : (
          <span className="icon-picker-placeholder">Select icon...</span>
        )}
        <span className="icon-picker-chevron">{isOpen ? '\u25B2' : '\u25BC'}</span>
      </div>

      {/* Render dropdown in a portal to avoid overflow clipping */}
      {dropdownContent && createPortal(dropdownContent, document.body)}
    </div>
  );
}

/**
 * IconPreview - Renders an icon preview.
 */
function IconPreview({ icon, size }: { icon: IconMetadata; size: number }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let mounted = true;
    setFailed(false);
    setImageUrl(null);

    useIconLibraryStore.getState().loadIconData(icon.id).then((data) => {
      if (mounted) {
        if (data) {
          setImageUrl(data.dataUrl);
        } else {
          setFailed(true);
        }
      }
    }).catch(() => {
      if (mounted) setFailed(true);
    });

    return () => {
      mounted = false;
    };
  }, [icon.id]);

  if (failed) {
    return (
      <div
        className="icon-preview-placeholder icon-preview-error"
        style={{ width: size, height: size }}
        title="Failed to load"
      />
    );
  }

  if (!imageUrl) {
    return <div className="icon-preview-placeholder icon-preview-loading" style={{ width: size, height: size }} />;
  }

  return (
    <img
      src={imageUrl}
      alt={icon.name}
      className="icon-preview"
      style={{ width: size, height: size }}
    />
  );
}

/**
 * Compact icon display for PropertyPanel.
 */
export function IconDisplay({
  iconId,
  size = 24,
}: {
  iconId: string | undefined;
  size?: number;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [iconName, setIconName] = useState<string>('');

  useEffect(() => {
    if (!iconId) {
      setImageUrl(null);
      setIconName('');
      return;
    }

    let mounted = true;

    // Call store directly to avoid function reference issues
    useIconLibraryStore.getState().loadIconData(iconId).then((data) => {
      if (mounted && data) {
        setImageUrl(data.dataUrl);
        setIconName(data.name);
      }
    });

    return () => {
      mounted = false;
    };
  }, [iconId]);

  if (!imageUrl) {
    return null;
  }

  return (
    <img
      src={imageUrl}
      alt={iconName}
      className="icon-display"
      style={{ width: size, height: size }}
      title={iconName}
    />
  );
}

export default IconPicker;
