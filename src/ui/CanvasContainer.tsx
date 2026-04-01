import { useEffect, useRef, useCallback, useState } from 'react';
import { Engine } from '../engine/Engine';
import { Camera } from '../engine/Camera';
import { TextEditor } from './TextEditor';
import { ContextMenu } from './ContextMenu';
import { ExportDialog } from './ExportDialog';
import { SaveToLibraryDialog } from './SaveToLibraryDialog';
import { FileViewerModal } from './FileViewerModal';
import { CollaborativeCursors } from './CollaborativeCursors';
import { SelectionHighlight } from './SelectionHighlight';
import { Minimap } from './Minimap';
import { useDocumentStore } from '../store/documentStore';
import { useHistoryStore } from '../store/historyStore';
import { useThemeStore } from '../store/themeStore';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { shapeRegistry } from '../shapes/ShapeRegistry';
import { Vec2 } from '../math/Vec2';
import { nanoid } from 'nanoid';
import { importFiles, ImportContext } from '../services/FileImportService';
import { getMimeType } from '../utils/fileUtils';

/**
 * Props for the CanvasContainer component.
 */
export interface CanvasContainerProps {
  /** Whether to show the background grid. Default: true */
  showGrid?: boolean;
  /** Whether to show the FPS counter. Default: false */
  showFps?: boolean;
  /** Additional CSS class names */
  className?: string;
  /** Called when the engine is ready, providing getImportContext */
  onEngineReady?: (getImportContext: () => ImportContext | null) => void;
}

/**
 * CanvasContainer is the bridge between React and the canvas engine.
 *
 * Responsibilities:
 * - Mounts and manages the canvas element
 * - Handles DPI scaling for crisp rendering on high-DPI displays
 * - Observes container resize and updates canvas dimensions
 * - Initializes the Engine which coordinates all components
 * - Cleans up resources on unmount
 *
 * Usage:
 * ```tsx
 * <CanvasContainer
 *   showGrid={true}
 *   showFps={process.env.NODE_ENV === 'development'}
 * />
 * ```
 */
export function CanvasContainer({
  showGrid = true,
  showFps = false,
  className,
  onEngineReady,
}: CanvasContainerProps) {
  // Refs for DOM elements and engine
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);

  // State for camera reference (for TextEditor positioning)
  const [camera, setCamera] = useState<Camera | null>(null);

  // Container dimensions for presence overlays
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  // Track canvas focus state for visual indicator
  const [isFocused, setIsFocused] = useState(false);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Export dialog state
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  // Save to library dialog state
  const [saveToLibraryOpen, setSaveToLibraryOpen] = useState(false);

  // File viewer state
  const viewingFileShapeId = useSessionStore((state) => state.viewingFileShapeId);
  const closeFileViewer = useSessionStore((state) => state.closeFileViewer);

  const getImportContext = useCallback((): ImportContext | null => {
    const engine = engineRef.current;
    if (!engine) return null;
    return { engine };
  }, []);

  /**
   * Update canvas size to match container, accounting for DPI.
   */
  const updateCanvasSize = useCallback(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const engine = engineRef.current;

    if (!container || !canvas || !engine) return;

    // Get container dimensions (CSS pixels)
    const rect = container.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    if (width > 0 && height > 0) {
      engine.resize(width, height);
      setDimensions({ width, height });
    }
  }, []);

  /**
   * Initialize engine on mount.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Create Engine
    const engine = new Engine(canvas, {
      showGrid,
      showFps,
      initialTool: 'select',
    });
    engineRef.current = engine;
    setCamera(engine.camera);

    // Notify parent that engine is ready
    onEngineReady?.((): ImportContext | null => {
      const eng = engineRef.current;
      if (!eng) return null;
      return { engine: eng };
    });

    // Set initial canvas size
    updateCanvasSize();

    // Cleanup on unmount
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []); // Only run on mount/unmount

  /**
   * Update renderer options when props change.
   */
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    engine.renderer.setOptions({ showGrid, showFps });
    engine.requestRender();
  }, [showGrid, showFps]);

  /**
   * Sync grid opacity from settings store.
   */
  const gridOpacity = useSettingsStore((state) => state.gridOpacity);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    engine.renderer.setOptions({ gridOpacity });
    engine.requestRender();
  }, [gridOpacity]);

  /**
   * Subscribe to theme changes and update renderer colors.
   */
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    // Update renderer with theme colors
    const updateThemeColors = () => {
      const { colors } = useThemeStore.getState();
      engine.renderer.setOptions({
        backgroundColor: colors.backgroundColor,
        gridColor: colors.gridColor,
        majorGridColor: colors.majorGridColor,
        originColor: colors.originColor,
        selectionColor: colors.selectionColor,
        handleFillColor: colors.handleFillColor,
        handleStrokeColor: colors.handleStrokeColor,
      });
      engine.requestRender();
    };

    // Initial update
    updateThemeColors();

    // Subscribe to theme changes
    const unsubscribe = useThemeStore.subscribe(updateThemeColors);

    return () => {
      unsubscribe();
    };
  }, []);

  /**
   * Subscribe to emphasis changes for focus animation.
   */
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    let lastEmphasis: string | null = null;

    // Update renderer with emphasis state
    const updateEmphasis = () => {
      const { emphasizedShapeId } = useSessionStore.getState();
      if (emphasizedShapeId !== lastEmphasis) {
        lastEmphasis = emphasizedShapeId;
        engine.renderer.setEmphasis(emphasizedShapeId);
        engine.requestRender();
      }
    };

    // Initial update
    updateEmphasis();

    // Subscribe to session store changes
    const unsubscribe = useSessionStore.subscribe(updateEmphasis);

    return () => {
      unsubscribe();
    };
  }, []);

  /**
   * Listen for layer panel collapse to return focus to canvas.
   */
  useEffect(() => {
    const handleLayerPanelCollapsed = () => {
      canvasRef.current?.focus();
    };

    window.addEventListener('layer-panel-collapsed', handleLayerPanelCollapsed);
    return () => {
      window.removeEventListener(
        'layer-panel-collapsed',
        handleLayerPanelCollapsed
      );
    };
  }, []);

  /**
   * Tauri native file drag-and-drop listener.
   * Tauri intercepts OS-level file drags — HTML5 drag events don't fire
   * for external file drops in the desktop app. We listen for Tauri's
   * own drag-drop event and read file contents via the fs plugin.
   */
  useEffect(() => {
    const isTauriEnv = typeof window !== 'undefined' &&
      ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

    if (!isTauriEnv) return;

    let unlisten: (() => void) | undefined;

    async function setup() {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const { readFile } = await import('@tauri-apps/plugin-fs');

        unlisten = await listen<{ paths: string[]; position: { x: number; y: number } }>(
          'tauri://drag-drop',
          async (event) => {
            const { paths, position } = event.payload;
            const ctx = getImportContext();
            if (!ctx || paths.length === 0) return;

            const canvas = canvasRef.current;
            if (!canvas) return;

            // Tauri provides physical coordinates; convert to logical
            const dpr = window.devicePixelRatio || 1;
            const rect = canvas.getBoundingClientRect();
            const screenPoint = new Vec2(
              position.x / dpr - rect.left,
              position.y / dpr - rect.top,
            );
            const worldPoint = ctx.engine.camera.screenToWorld(screenPoint);

            // Read each file from disk
            const files: File[] = [];
            for (const filePath of paths) {
              try {
                const bytes = await readFile(filePath);
                const fileName = filePath.split(/[\\/]/).pop() || 'unknown';
                const mimeType = getMimeType(fileName);
                files.push(new File([bytes], fileName, { type: mimeType }));
              } catch (err) {
                console.error('Failed to read dropped file:', filePath, err);
              }
            }

            if (files.length > 0) {
              void importFiles(files, worldPoint, ctx);
            }
          },
        );
      } catch (err) {
        console.error('Failed to setup Tauri drag-drop listener:', err);
      }
    }

    setup();

    return () => { unlisten?.(); };
  }, [getImportContext]);

  /**
   * Clipboard paste handler — allows pasting files onto the canvas.
   * Listens on document level since canvas paste events are unreliable.
   */
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      // Only handle when canvas is focused
      if (document.activeElement !== canvasRef.current) return;

      const files = e.clipboardData?.files;
      if (!files || files.length === 0) return;

      e.preventDefault();
      const ctx = getImportContext();
      if (!ctx) return;

      const center = ctx.engine.camera.getViewportCenter();
      void importFiles(files, center, ctx);
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [getImportContext]);

  /**
   * Set up ResizeObserver to handle container resize.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver(() => {
      updateCanvasSize();
    });

    resizeObserver.observe(container);

    // Also listen for DPI changes (e.g., moving window between monitors)
    const mediaQuery = window.matchMedia(
      `(resolution: ${window.devicePixelRatio}dppx)`
    );

    const handleDpiChange = () => {
      updateCanvasSize();
    };

    mediaQuery.addEventListener('change', handleDpiChange);

    return () => {
      resizeObserver.disconnect();
      mediaQuery.removeEventListener('change', handleDpiChange);
    };
  }, [updateCanvasSize]);

  /**
   * Handle focus for keyboard events.
   * Canvas needs tabIndex to be focusable.
   */
  const handleCanvasClick = useCallback(() => {
    canvasRef.current?.focus();
  }, []);

  const handleFocus = useCallback(() => {
    setIsFocused(true);
  }, []);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
  }, []);

  /**
   * Handle right-click to show context menu.
   */
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleExportSelection = useCallback(() => {
    setExportDialogOpen(true);
  }, []);

  const handleCloseExportDialog = useCallback(() => {
    setExportDialogOpen(false);
  }, []);

  const handleSaveToLibrary = useCallback(() => {
    setSaveToLibraryOpen(true);
  }, []);

  const handleCloseSaveToLibrary = useCallback(() => {
    setSaveToLibraryOpen(false);
  }, []);

  /**
   * Handle drag over canvas to allow drop.
   */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/diagrammer-shape') ||
        e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  /**
   * Handle drop to create a shape at the drop position.
   */
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();

    const engine = engineRef.current;
    if (!engine) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const screenPoint = new Vec2(e.clientX - rect.left, e.clientY - rect.top);
    const worldPoint = engine.camera.screenToWorld(screenPoint);

    // Handle file drops (web mode only — Tauri handles its own via tauri://drag-drop)
    const isTauriEnv = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
    if (!isTauriEnv && e.dataTransfer.files.length > 0) {
      const ctx = getImportContext();
      if (ctx) {
        void importFiles(e.dataTransfer.files, worldPoint, ctx);
      }
      return;
    }

    // Handle shape drops (existing logic)
    const shapeType = e.dataTransfer.getData('application/diagrammer-shape');
    if (!shapeType) return;

    try {
      const handler = shapeRegistry.getHandler(shapeType);
      const id = nanoid();
      const shape = handler.create(worldPoint, id);

      useHistoryStore.getState().push(`Create ${shapeType}`);
      useDocumentStore.getState().addShape(shape);
      engine.spatialIndex.insert(shape);
      useSessionStore.getState().select([id]);
      useSessionStore.getState().setActiveTool('select');
      engine.requestRender();
    } catch {
      // Shape type not registered — ignore
    }
  }, [getImportContext]);

  return (
    <div
      ref={containerRef}
      className={className}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <canvas
        ref={canvasRef}
        tabIndex={0}
        onClick={handleCanvasClick}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onContextMenu={handleContextMenu}
        style={{
          display: 'block',
          outline: 'none',
          touchAction: 'none', // Prevent browser touch gestures
        }}
      />
      {/* Focus indicator - shows when canvas is not focused */}
      {!isFocused && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '3px',
            pointerEvents: 'none',
            background: 'linear-gradient(90deg, rgba(59, 130, 246, 0.6) 0%, rgba(147, 197, 253, 0.4) 50%, rgba(59, 130, 246, 0.6) 100%)',
            boxShadow: '0 1px 4px rgba(59, 130, 246, 0.3)',
          }}
        />
      )}
      {/* Collaborative presence overlays */}
      <SelectionHighlight width={dimensions.width} height={dimensions.height} />
      <CollaborativeCursors width={dimensions.width} height={dimensions.height} />
      <Minimap canvasWidth={dimensions.width} canvasHeight={dimensions.height} />
      <TextEditor camera={camera} />
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={handleCloseContextMenu}
          onExport={handleExportSelection}
          onSaveToLibrary={handleSaveToLibrary}
        />
      )}
      <ExportDialog
        isOpen={exportDialogOpen}
        onClose={handleCloseExportDialog}
        scope="selection"
        defaultFilename="selection"
      />
      <SaveToLibraryDialog
        isOpen={saveToLibraryOpen}
        onClose={handleCloseSaveToLibrary}
      />
      {viewingFileShapeId && (
        <FileViewerModal
          shapeId={viewingFileShapeId}
          onClose={closeFileViewer}
        />
      )}
    </div>
  );
}

export default CanvasContainer;
