/**
 * ShapePicker — the unified "insert a shape" surface. One toolbar button opens a
 * portal-anchored panel that browses every insertable shape: the curated basic
 * primitives, the built-in libraries (flowchart / ERD / UML / activity), and the
 * user's custom-library items, all in one searchable grid. (It supersedes the
 * old split ShapePicker + CustomShapePicker buttons.)
 *
 * Features:
 * - Search-first: fuzzy, synonym-aware filtering across all categories.
 * - Category pills (All + per-category + Custom when present).
 * - "Recent" row when idle, persisted across sessions.
 * - Real keyboard nav (combobox pattern): type to filter, arrows to move,
 *   Enter to insert, Esc to close — with ARIA listbox/option semantics.
 * - Built-in shapes drag onto the canvas; custom shapes activate their tool.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Shapes, ChevronUp, ChevronDown, Search, X } from 'lucide-react';
import { Icon, ICON_SM } from './icons';
import { shapeRegistry } from '../shapes/ShapeRegistry';
import { useShapeLibraryStore } from '../store/shapeLibraryStore';
import {
  useCustomShapeLibraryStore,
  initializeCustomShapeLibrary,
} from '../store/customShapeLibraryStore';
import { useShapePickerStore } from '../store/shapePickerStore';
import { useSessionStore } from '../store/sessionStore';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';
import { createShapeAtCenter } from '../engine/CommandRegistry';
import { buildEntries, categoryLabel, PICKER_CATEGORY_ORDER } from './shapePicker/entries';
import { filterEntries } from './shapePicker/filter';
import { ALL_CATEGORY, type PickerCategory, type PickerEntry } from './shapePicker/types';
import './ShapePicker.css';

/** Pixel size of each preview tile. */
const PREVIEW_SIZE = 46;

export function ShapePicker() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<PickerCategory>(ALL_CATEGORY);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const isInitialized = useShapeLibraryStore((s) => s.isInitialized);
  // Subscribe so the entry list recomputes if registrations change.
  const registeredDefinitions = useShapeLibraryStore((s) => s.registeredDefinitions);

  const customInitialized = useCustomShapeLibraryStore((s) => s.isInitialized);
  const customItemsCache = useCustomShapeLibraryStore((s) => s.itemsCache);

  const recents = useShapePickerStore((s) => s.recents);
  const recordUse = useShapePickerStore((s) => s.recordUse);

  const activeTool = useSessionStore((s) => s.activeTool);
  const setActiveTool = useSessionStore((s) => s.setActiveTool);

  // Lazily initialize the custom library the first time the picker is used.
  useEffect(() => {
    if (isOpen && !customInitialized) initializeCustomShapeLibrary();
  }, [isOpen, customInitialized]);

  // Built-in metadata is registered eagerly at boot; recompute defensively if
  // the registered set ever changes.
  const builtinMetadata = useMemo(
    () => shapeRegistry.getAllMetadata(),
    [registeredDefinitions]
  );
  const customItems = useMemo(() => Object.values(customItemsCache), [customItemsCache]);

  const entries = useMemo(
    () => buildEntries(builtinMetadata, customItems),
    [builtinMetadata, customItems]
  );
  const entryById = useMemo(() => {
    const map = new Map<string, PickerEntry>();
    for (const e of entries) map.set(e.id, e);
    return map;
  }, [entries]);

  // Which categories actually have entries, in display order (custom last).
  const categories = useMemo(() => {
    const present = new Set(entries.map((e) => e.category));
    const ordered = PICKER_CATEGORY_ORDER.filter((c) => present.has(c));
    if (present.has('custom')) ordered.push('custom');
    return ordered;
  }, [entries]);

  const filtered = useMemo(
    () => filterEntries(entries, query, selectedCategory),
    [entries, query, selectedCategory]
  );

  // Recents only when idle (no query, "All" tab); resolve ids → live entries.
  const recentEntries = useMemo(() => {
    if (query.trim() || selectedCategory !== ALL_CATEGORY) return [];
    return recents
      .map((id) => entryById.get(id))
      .filter((e): e is PickerEntry => e !== undefined)
      .slice(0, 8);
  }, [query, selectedCategory, recents, entryById]);

  // Clamp the keyboard cursor whenever the visible list changes.
  useEffect(() => {
    setActiveIndex((i) => (filtered.length === 0 ? 0 : Math.min(i, filtered.length - 1)));
  }, [filtered]);

  const activeLibraryEntry = useMemo(
    () => entries.find((e) => e.toolType === activeTool),
    [entries, activeTool]
  );
  const isShapeActive = activeLibraryEntry !== undefined;

  const updatePosition = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPosition({ top: rect.bottom + 4, left: rect.left });
    }
  }, []);

  const close = useCallback(() => setIsOpen(false), []);

  const handleToggle = useCallback(() => {
    if (!isOpen) {
      updatePosition();
      setQuery('');
      setSelectedCategory(ALL_CATEGORY);
      setActiveIndex(0);
    }
    setIsOpen((v) => !v);
  }, [isOpen, updatePosition]);

  // Focus search when opened.
  useEffect(() => {
    if (isOpen) {
      const id = window.setTimeout(() => searchRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [isOpen]);

  // Reposition while open; close on outside click / Escape.
  useEffect(() => {
    if (!isOpen) return undefined;

    const onReposition = () => updatePosition();
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const dropdown = document.querySelector('.shape-picker-dropdown-portal');
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        (!dropdown || !dropdown.contains(target))
      ) {
        close();
      }
    };

    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    document.addEventListener('mousedown', onClickOutside);
    return () => {
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
      document.removeEventListener('mousedown', onClickOutside);
    };
  }, [isOpen, updatePosition, close]);

  const handleInsert = useCallback(
    (entry: PickerEntry) => {
      recordUse(entry.id);
      if (entry.kind === 'builtin') {
        try {
          createShapeAtCenter(entry.toolType);
        } catch {
          setActiveTool(entry.toolType);
        }
      } else {
        // Custom shapes activate their placement tool (click canvas to drop).
        setActiveTool(entry.toolType);
      }
      close();
    },
    [recordUse, setActiveTool, close]
  );

  const handleDragStart = useCallback((e: React.DragEvent, entry: PickerEntry) => {
    // Only built-in shapes have a registry handler the canvas drop can build.
    if (entry.kind !== 'builtin') return;
    e.dataTransfer.setData('application/docushark-shape', entry.toolType);
    e.dataTransfer.effectAllowed = 'copy';
  }, []);

  // Combobox keyboard handling — focus stays in the search input.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (filtered.length === 0) return;
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          break;
        case 'Home':
          e.preventDefault();
          setActiveIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setActiveIndex(filtered.length - 1);
          break;
        case 'Enter': {
          e.preventDefault();
          const entry = filtered[activeIndex];
          if (entry) handleInsert(entry);
          break;
        }
        default:
          break;
      }
    },
    [filtered, activeIndex, handleInsert, close]
  );

  if (!isInitialized) return null;

  const activeOptionId =
    filtered.length > 0 && filtered[activeIndex]
      ? `shape-opt-${filtered[activeIndex]!.id}`
      : undefined;

  return (
    <div className="shape-picker" ref={containerRef}>
      <button
        ref={triggerRef}
        className={`shape-picker-trigger ${isOpen ? 'open' : ''} ${isShapeActive ? 'active' : ''}`}
        onClick={handleToggle}
        title="Shape library"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="shape-picker-trigger-icon">
          {activeLibraryEntry?.thumbnail ? (
            <img src={activeLibraryEntry.thumbnail} alt="" className="shape-picker-trigger-thumb" />
          ) : activeLibraryEntry?.glyph ? (
            <span className="shape-picker-trigger-glyph">{activeLibraryEntry.glyph}</span>
          ) : (
            <Icon icon={Shapes} />
          )}
        </span>
        <span className="shape-picker-chevron">
          {isOpen ? <Icon icon={ChevronUp} {...ICON_SM} /> : <Icon icon={ChevronDown} {...ICON_SM} />}
        </span>
      </button>

      {isOpen &&
        position &&
        createPortal(
          <div
            className="shape-picker-dropdown-portal"
            style={{ top: position.top, left: position.left }}
            onKeyDown={handleKeyDown}
          >
            {/* Search */}
            <div className="shape-picker-search-row">
              <span className="shape-picker-search-icon">
                <Icon icon={Search} {...ICON_SM} />
              </span>
              <input
                ref={searchRef}
                className="shape-picker-search"
                type="text"
                placeholder="Search shapes…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(0);
                }}
                role="combobox"
                aria-expanded
                aria-controls="shape-picker-grid"
                aria-activedescendant={activeOptionId}
              />
              {query && (
                <button
                  className="shape-picker-search-clear"
                  onClick={() => {
                    setQuery('');
                    searchRef.current?.focus();
                  }}
                  title="Clear search"
                  aria-label="Clear search"
                >
                  <Icon icon={X} {...ICON_SM} />
                </button>
              )}
            </div>

            {/* Category pills */}
            <div className="shape-picker-categories" role="tablist">
              <button
                className={`shape-picker-category ${selectedCategory === ALL_CATEGORY ? 'active' : ''}`}
                onClick={() => {
                  setSelectedCategory(ALL_CATEGORY);
                  setActiveIndex(0);
                }}
                role="tab"
                aria-selected={selectedCategory === ALL_CATEGORY}
              >
                All
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  className={`shape-picker-category ${selectedCategory === cat ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedCategory(cat);
                    setActiveIndex(0);
                  }}
                  role="tab"
                  aria-selected={selectedCategory === cat}
                >
                  {categoryLabel(cat)}
                </button>
              ))}
            </div>

            {/* Recent row (idle only) */}
            {recentEntries.length > 0 && (
              <div className="shape-picker-recent">
                <div className="shape-picker-section-label">Recent</div>
                <div className="shape-picker-recent-row">
                  {recentEntries.map((entry) => (
                    <ShapeTile
                      key={`recent-${entry.id}`}
                      entry={entry}
                      active={activeTool === entry.toolType}
                      onInsert={handleInsert}
                      onDragStart={handleDragStart}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Main grid */}
            <div
              id="shape-picker-grid"
              className="shape-picker-grid"
              role="listbox"
              aria-label="Shapes"
            >
              {filtered.length === 0 ? (
                <div className="shape-picker-empty">
                  {query ? `No shapes match "${query}"` : 'No shapes in this category'}
                </div>
              ) : (
                filtered.map((entry, idx) => (
                  <ShapeTile
                    key={entry.id}
                    entry={entry}
                    active={idx === activeIndex || activeTool === entry.toolType}
                    keyboardActive={idx === activeIndex}
                    onInsert={handleInsert}
                    onDragStart={handleDragStart}
                  />
                ))
              )}
            </div>

            <div className="shape-picker-hint">
              Drag onto the canvas, or press Enter to insert at center
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

/** One selectable shape tile (preview + name). */
function ShapeTile({
  entry,
  active,
  keyboardActive,
  onInsert,
  onDragStart,
}: {
  entry: PickerEntry;
  active: boolean;
  keyboardActive?: boolean;
  onInsert: (entry: PickerEntry) => void;
  onDragStart: (e: React.DragEvent, entry: PickerEntry) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  // Preview tiles track the app text-size setting (Appearance → UI scale) so
  // they grow/shrink with the rest of the chrome instead of staying a fixed,
  // hard-to-read 46px (JP-325).
  const uiScale = useUIPreferencesStore((s) => s.appearancePrefs.uiScale);
  const previewSize = Math.round(PREVIEW_SIZE * uiScale);

  // Keep the keyboard-focused tile in view.
  useEffect(() => {
    if (keyboardActive) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [keyboardActive]);

  return (
    <button
      ref={ref}
      id={`shape-opt-${entry.id}`}
      className={`shape-picker-item ${active ? 'selected' : ''} ${keyboardActive ? 'kbd-active' : ''}`}
      onClick={() => onInsert(entry)}
      draggable={entry.kind === 'builtin'}
      onDragStart={(e) => onDragStart(e, entry)}
      title={entry.name}
      role="option"
      aria-selected={active}
    >
      <ShapePreview entry={entry} size={previewSize} />
      <span className="shape-picker-item-name">{entry.name}</span>
    </button>
  );
}

/** Resolve a computed CSS variable (canvas can't read CSS vars directly). */
function getCSSVariable(varName: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return value || fallback;
}

/**
 * Preview for an entry: custom thumbnail → built-in path/primitive → glyph.
 */
function ShapePreview({ entry, size }: { entry: PickerEntry; size: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isCanvas = entry.kind === 'builtin';

  useEffect(() => {
    if (!isCanvas) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const fillColor = getCSSVariable('--color-primary-light', '#dbe4f0');
    const strokeColor = getCSSVariable('--color-primary', '#1f3354');

    const type = entry.builtinType ?? entry.toolType;
    const definition = useShapeLibraryStore.getState().getShapeDefinition(type);
    const padding = 6;
    const w = 100;
    const h = 70;

    const drawPath = (path: Path2D, contentW: number, contentH: number) => {
      const scale = Math.min((size - padding * 2) / contentW, (size - padding * 2) / contentH);
      ctx.save();
      ctx.translate(size / 2, size / 2);
      ctx.scale(scale, scale);
      ctx.fillStyle = fillColor;
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2 / scale;
      ctx.fill(path);
      ctx.stroke(path);
      ctx.restore();
    };

    if (definition?.pathBuilder) {
      const cw = definition.metadata.defaultWidth;
      const ch = definition.metadata.defaultHeight;
      // pathBuilder draws centred on the origin (same as the canvas handler), so
      // no recentre — drawPath already translates to the tile centre. (The old
      // -cw/2,-ch/2 shift double-offset every preview up-and-left.)
      const raw = definition.pathBuilder(cw, ch);
      drawPath(raw, cw, ch);
    } else if (type === 'rectangle') {
      const p = new Path2D();
      p.roundRect(-w / 2, -h / 2, w, h, 6);
      drawPath(p, w, h);
    } else if (type === 'ellipse') {
      const p = new Path2D();
      p.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      drawPath(p, w, h);
    } else {
      // Glyph fallback (e.g. text).
      ctx.fillStyle = getCSSVariable('--text-primary', '#0a1525');
      ctx.font = `${size * 0.55}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(entry.glyph ?? '?', size / 2, size / 2);
    }
  }, [entry, size, isCanvas]);

  if (!isCanvas) {
    return entry.thumbnail ? (
      <img
        src={entry.thumbnail}
        alt=""
        className="shape-picker-thumb"
        style={{ width: size, height: size }}
      />
    ) : (
      <span className="shape-picker-glyph" style={{ width: size, height: size }}>
        {entry.glyph ?? '▢'}
      </span>
    );
  }

  return (
    <canvas ref={canvasRef} className="shape-preview-canvas" style={{ width: size, height: size }} />
  );
}

export default ShapePicker;
