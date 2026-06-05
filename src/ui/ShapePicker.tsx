/**
 * ShapePicker - Component for selecting library shapes from shape libraries.
 *
 * Features:
 * - Browse shapes by category (flowchart, etc.)
 * - Visual shape previews with canvas rendering
 * - Click to activate shape tool
 * - Keyboard navigation support
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Shapes, ChevronUp, ChevronDown } from 'lucide-react';
import { useShapeLibraryStore } from '../store/shapeLibraryStore';
import { useSessionStore } from '../store/sessionStore';
import { createShapeAtCenter } from '../engine/CommandRegistry';
import type { ShapeMetadata, ShapeLibraryCategory } from '../shapes/ShapeMetadata';
import './ShapePicker.css';

/** View size options */
type ViewSize = 'small' | 'medium' | 'large';

const VIEW_SIZES: { value: ViewSize; label: string }[] = [
  { value: 'small', label: 'S' },
  { value: 'medium', label: 'M' },
  { value: 'large', label: 'L' },
];

/** Preview sizes for each view size */
const PREVIEW_SIZES: Record<ViewSize, number> = {
  small: 32,
  medium: 48,
  large: 72,
};

/**
 * Category labels for display.
 */
const CATEGORY_LABELS: Record<ShapeLibraryCategory, string> = {
  basic: 'Basic',
  flowchart: 'Flowchart',
  erd: 'ERD',
  'uml-class': 'UML Class',
  'uml-usecase': 'UML Use Case',
  'uml-sequence': 'UML Sequence',
  'uml-activity': 'UML Activity',
  custom: 'Custom',
};

/**
 * Categories to show in the picker (ordered).
 */
const PICKER_CATEGORIES: ShapeLibraryCategory[] = ['flowchart', 'erd', 'uml-class', 'uml-usecase', 'uml-sequence', 'uml-activity'];

/**
 * ShapePicker component.
 */
export function ShapePicker() {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<ShapeLibraryCategory>('flowchart');
  const [viewSize, setViewSize] = useState<ViewSize>('small');
  const containerRef = useRef<HTMLDivElement>(null);

  const { getShapesByCategory, getAllLibraryShapes, isInitialized } = useShapeLibraryStore();
  // Subscribe to registeredDefinitions so memos recompute after async loading
  const registeredDefinitions = useShapeLibraryStore((s) => s.registeredDefinitions);
  const activeTool = useSessionStore((state) => state.activeTool);
  const setActiveTool = useSessionStore((state) => state.setActiveTool);

  // Get shapes for current category
  const shapes = useMemo(() => {
    if (!isInitialized) return [];
    return getShapesByCategory(selectedCategory);
  }, [isInitialized, selectedCategory, getShapesByCategory, registeredDefinitions]);

  // Get all library shapes to check if current tool is a library shape
  const allLibraryShapes = useMemo(() => {
    if (!isInitialized) return [];
    return getAllLibraryShapes();
  }, [isInitialized, getAllLibraryShapes, registeredDefinitions]);

  // Check if current tool is a library shape
  const isLibraryShapeActive = useMemo(() => {
    return allLibraryShapes.some((s) => s.type === activeTool);
  }, [allLibraryShapes, activeTool]);

  // Get active library shape metadata for display
  const activeLibraryShape = useMemo(() => {
    if (!isLibraryShapeActive) return undefined;
    return allLibraryShapes.find((s) => s.type === activeTool);
  }, [isLibraryShapeActive, allLibraryShapes, activeTool]);

  // Get category counts
  const categoryCounts = useMemo(() => {
    if (!isInitialized) return {} as Record<ShapeLibraryCategory, number>;
    const counts: Record<ShapeLibraryCategory, number> = {
      basic: 0,
      flowchart: 0,
      erd: 0,
      'uml-class': 0,
      'uml-usecase': 0,
      'uml-sequence': 0,
      'uml-activity': 0,
      custom: 0,
    };
    for (const cat of PICKER_CATEGORIES) {
      counts[cat] = getShapesByCategory(cat).length;
    }
    return counts;
  }, [isInitialized, getShapesByCategory, registeredDefinitions]);

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

  // Handle shape selection — create a default-sized shape at the viewport center
  const handleSelect = useCallback(
    (shape: ShapeMetadata) => {
      try {
        createShapeAtCenter(shape.type);
      } catch {
        // Fallback: activate the tool (e.g. for shapes without a registered handler)
        setActiveTool(shape.type);
      }
      setIsOpen(false);
    },
    [setActiveTool]
  );

  // Handle drag start for drag-and-drop shape creation
  const handleDragStart = useCallback(
    (e: React.DragEvent, shape: ShapeMetadata) => {
      e.dataTransfer.setData('application/docushark-shape', shape.type);
      e.dataTransfer.effectAllowed = 'copy';
    },
    []
  );

  // Toggle dropdown
  const handleToggle = useCallback(() => {
    setIsOpen(!isOpen);
  }, [isOpen]);

  if (!isInitialized) {
    return null;
  }

  return (
    <div className="shape-picker" ref={containerRef}>
      <button
        className={`shape-picker-trigger ${isOpen ? 'open' : ''} ${isLibraryShapeActive ? 'active' : ''}`}
        onClick={handleToggle}
        title="Shape library"
      >
        {activeLibraryShape ? (
          <span className="shape-picker-trigger-icon">{activeLibraryShape.icon}</span>
        ) : (
          <span className="shape-picker-trigger-icon"><Shapes size={16} strokeWidth={1.5} /></span>
        )}
        <span className="shape-picker-chevron">{isOpen ? <ChevronUp size={12} strokeWidth={1.5} /> : <ChevronDown size={12} strokeWidth={1.5} />}</span>
      </button>

      {isOpen && (
        <div className="shape-picker-dropdown">
          {/* Header with category tabs and view options */}
          <div className="shape-picker-header">
            <div className="shape-picker-categories">
              {PICKER_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  className={`shape-picker-category ${selectedCategory === cat ? 'active' : ''}`}
                  onClick={() => setSelectedCategory(cat)}
                >
                  {CATEGORY_LABELS[cat]} ({categoryCounts[cat] || 0})
                </button>
              ))}
            </div>
            <div className="shape-picker-view-options">
              {VIEW_SIZES.map((size) => (
                <button
                  key={size.value}
                  className={`shape-picker-view-btn ${viewSize === size.value ? 'active' : ''}`}
                  onClick={() => setViewSize(size.value)}
                  title={`${size.value.charAt(0).toUpperCase() + size.value.slice(1)} view`}
                >
                  {size.label}
                </button>
              ))}
            </div>
          </div>

          {/* Shapes grid */}
          <div className={`shape-picker-grid size-${viewSize}`}>
            {shapes.length === 0 ? (
              <div className="shape-picker-empty">No shapes in this category</div>
            ) : (
              shapes.map((shape) => (
                <button
                  key={shape.type}
                  className={`shape-picker-item ${activeTool === shape.type ? 'selected' : ''}`}
                  onClick={() => handleSelect(shape)}
                  draggable
                  onDragStart={(e) => handleDragStart(e, shape)}
                  title={shape.name}
                >
                  <ShapePreview metadata={shape} size={PREVIEW_SIZES[viewSize]} />
                  <span className="shape-picker-item-name">{shape.name}</span>
                </button>
              ))
            )}
          </div>

          <div className="shape-picker-hint">
            Drag onto canvas or click to select tool
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Helper to get computed CSS variable value from the document.
 */
function getCSSVariable(varName: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return value || fallback;
}

/**
 * ShapePreview - Renders a shape preview using canvas.
 */
function ShapePreview({ metadata, size }: { metadata: ShapeMetadata; size: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set up high-DPI canvas
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    // Clear
    ctx.clearRect(0, 0, size, size);

    // Get theme-aware colors (CSS variables don't work directly in canvas)
    const fillColor = getCSSVariable('--color-primary', '#1f3354');
    const strokeColor = getCSSVariable('--color-primary-dark', '#0e1c30');

    // Try to render using the shape's path builder
    const shapeLibraryStore = useShapeLibraryStore.getState();
    const definition = shapeLibraryStore.getShapeDefinition(metadata.type);

    if (definition && definition.pathBuilder) {
      // Calculate scale to fit within preview area with padding
      const padding = 4;
      const availableWidth = size - padding * 2;
      const availableHeight = size - padding * 2;
      const scaleX = availableWidth / metadata.defaultWidth;
      const scaleY = availableHeight / metadata.defaultHeight;
      const scale = Math.min(scaleX, scaleY);

      // Center in preview
      const scaledWidth = metadata.defaultWidth * scale;
      const scaledHeight = metadata.defaultHeight * scale;
      const offsetX = (size - scaledWidth) / 2;
      const offsetY = (size - scaledHeight) / 2;

      ctx.save();
      ctx.translate(offsetX + scaledWidth / 2, offsetY + scaledHeight / 2);
      ctx.scale(scale, scale);

      // Build path
      const path = definition.pathBuilder(metadata.defaultWidth, metadata.defaultHeight);

      // Draw with resolved CSS colors
      ctx.fillStyle = fillColor;
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2 / scale;
      ctx.fill(path);
      ctx.stroke(path);

      ctx.restore();
    } else {
      // Fallback: render the icon as text
      const textColor = getCSSVariable('--text-primary', '#0a1525');
      ctx.fillStyle = textColor;
      ctx.font = `${size * 0.6}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(metadata.icon, size / 2, size / 2);
    }
  }, [metadata, size]);

  return (
    <canvas
      ref={canvasRef}
      className="shape-preview-canvas"
      style={{ width: size, height: size }}
    />
  );
}

export default ShapePicker;
