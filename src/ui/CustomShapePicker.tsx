/**
 * CustomShapePicker - Component for selecting shapes from custom user libraries.
 *
 * Features:
 * - Browse shapes from custom libraries
 * - Visual shape previews with thumbnails
 * - Click to activate custom shape tool for placement
 * - Keyboard navigation support
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Boxes, Square, ChevronUp, ChevronDown } from 'lucide-react';
import { Icon } from './icons';
import { useCustomShapeLibraryStore, initializeCustomShapeLibrary } from '../store/customShapeLibraryStore';
import { useSessionStore } from '../store/sessionStore';
import type { CustomShapeItem, CustomShapeLibrary } from '../storage/ShapeLibraryTypes';
import './CustomShapePicker.css';

/** View size options */
type ViewSize = 'small' | 'medium' | 'large';

const VIEW_SIZES: { value: ViewSize; label: string }[] = [
  { value: 'small', label: 'S' },
  { value: 'medium', label: 'M' },
  { value: 'large', label: 'L' },
];

/**
 * CustomShapePicker component.
 */
export function CustomShapePicker() {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(null);
  const [viewSize, setViewSize] = useState<ViewSize>('small');
  const containerRef = useRef<HTMLDivElement>(null);

  const {
    libraries,
    isInitialized,
    getLibraryItems,
  } = useCustomShapeLibraryStore();

  const activeTool = useSessionStore((state) => state.activeTool);
  const setActiveTool = useSessionStore((state) => state.setActiveTool);

  // Initialize on mount
  useEffect(() => {
    if (!isInitialized) {
      initializeCustomShapeLibrary();
    }
  }, [isInitialized]);

  // Select first library when opened if none selected
  useEffect(() => {
    if (isOpen && libraries.length > 0 && !selectedLibraryId) {
      setSelectedLibraryId(libraries[0]!.id);
    }
  }, [isOpen, libraries, selectedLibraryId]);

  // Get items for selected library
  const libraryItems = useMemo(() => {
    if (!selectedLibraryId) return [];
    return getLibraryItems(selectedLibraryId);
  }, [selectedLibraryId, getLibraryItems]);

  // Check if current tool is a custom shape tool
  const isCustomShapeActive = useMemo(() => {
    return activeTool.startsWith('custom-shape:');
  }, [activeTool]);

  // Get active custom shape item for display
  const activeCustomItem = useMemo(() => {
    if (!isCustomShapeActive) return undefined;
    const itemId = activeTool.replace('custom-shape:', '');
    const { itemsCache } = useCustomShapeLibraryStore.getState();
    return itemsCache[itemId];
  }, [isCustomShapeActive, activeTool]);

  // Close picker when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // Handle shape selection - activate custom shape tool
  const handleSelect = useCallback(
    (item: CustomShapeItem) => {
      setActiveTool(`custom-shape:${item.id}`);
      setIsOpen(false);
    },
    [setActiveTool]
  );

  // Toggle dropdown
  const handleToggle = useCallback(() => {
    setIsOpen(!isOpen);
  }, [isOpen]);

  // Handle library change
  const handleLibraryChange = useCallback((library: CustomShapeLibrary) => {
    setSelectedLibraryId(library.id);
  }, []);

  if (!isInitialized) {
    return null;
  }

  // Don't render if no custom libraries exist
  if (libraries.length === 0) {
    return null;
  }

  const selectedLibrary = libraries.find((lib) => lib.id === selectedLibraryId);

  return (
    <div className="custom-shape-picker" ref={containerRef}>
      <button
        className={`custom-shape-picker-trigger ${isOpen ? 'open' : ''} ${isCustomShapeActive ? 'active' : ''}`}
        onClick={handleToggle}
        title="Custom shapes"
      >
        {activeCustomItem ? (
          <span className="custom-shape-picker-trigger-icon">
            {activeCustomItem.thumbnail ? (
              <img src={activeCustomItem.thumbnail} alt="" className="custom-shape-picker-trigger-thumb" />
            ) : (
              <Boxes size={16} strokeWidth={1.5} />
            )}
          </span>
        ) : (
          <span className="custom-shape-picker-trigger-icon"><Boxes size={16} strokeWidth={1.5} /></span>
        )}
        <span className="custom-shape-picker-chevron">{isOpen ? <ChevronUp size={12} strokeWidth={1.5} /> : <ChevronDown size={12} strokeWidth={1.5} />}</span>
      </button>

      {isOpen && (
        <div className="custom-shape-picker-dropdown">
          {/* Header with library tabs and view options */}
          <div className="custom-shape-picker-header">
            <div className="custom-shape-picker-libraries">
              {libraries.map((lib) => (
                <button
                  key={lib.id}
                  className={`custom-shape-picker-library ${selectedLibraryId === lib.id ? 'active' : ''}`}
                  onClick={() => handleLibraryChange(lib)}
                >
                  {lib.name} ({lib.itemCount})
                </button>
              ))}
            </div>
            <div className="custom-shape-picker-view-options">
              {VIEW_SIZES.map((size) => (
                <button
                  key={size.value}
                  className={`custom-shape-picker-view-btn ${viewSize === size.value ? 'active' : ''}`}
                  onClick={() => setViewSize(size.value)}
                  title={`${size.value.charAt(0).toUpperCase() + size.value.slice(1)} view`}
                >
                  {size.label}
                </button>
              ))}
            </div>
          </div>

          {/* Shapes grid */}
          <div className={`custom-shape-picker-grid size-${viewSize}`}>
            {!selectedLibrary ? (
              <div className="custom-shape-picker-empty">Select a library</div>
            ) : libraryItems.length === 0 ? (
              <div className="custom-shape-picker-empty">
                No shapes in this library.
                <br />
                <span className="custom-shape-picker-hint">
                  Right-click shapes to save them here.
                </span>
              </div>
            ) : (
              libraryItems.map((item) => (
                <button
                  key={item.id}
                  className={`custom-shape-picker-item ${activeTool === `custom-shape:${item.id}` ? 'selected' : ''}`}
                  onClick={() => handleSelect(item)}
                  title={item.name}
                >
                  <div className="custom-shape-picker-item-preview">
                    {item.thumbnail ? (
                      <img src={item.thumbnail} alt={item.name} />
                    ) : (
                      <span className="custom-shape-picker-item-placeholder">
                        {item.type === 'group' ? <Icon icon={Boxes} size={28} /> : <Icon icon={Square} size={28} />}
                      </span>
                    )}
                  </div>
                  <span className="custom-shape-picker-item-name">{item.name}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default CustomShapePicker;
