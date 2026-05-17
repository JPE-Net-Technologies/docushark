import { useEffect, useRef, useState, useCallback } from 'react';
import './App.css';
import { CanvasContainer } from './CanvasContainer';
import { PropertyPanel } from './PropertyPanel';
import { LayerPanel } from './LayerPanel';
import { SettingsModal } from './SettingsModal';
import { SplitPane } from './SplitPane';
import { DocumentEditorPanel } from './DocumentEditorPanel';
import { UnifiedToolbar } from './UnifiedToolbar';
import { StatusBar } from './StatusBar';
import { PresenceIndicators } from './PresenceIndicators';
import { NotificationToast } from './NotificationToast';
import { ErrorBoundary } from './ErrorBoundary';
import { ConnectionStatusBanner } from './ConnectionStatusBanner';
import { CommandPalette } from './CommandPalette';
import { ShapeSearchPanel } from './ShapeSearchPanel';
import { Whiteboard } from './Whiteboard';
import { usePageStore } from '../store/pageStore';
import { useHistoryStore } from '../store/historyStore';
import { initializePersistence, usePersistenceStore } from '../store/persistenceStore';
import { useDocumentStore } from '../store/documentStore';
import { initConnectionNotifications } from '../store/connectionStore';
import { useRelayDocumentStore } from '../store/relayDocumentStore';
import { useAutoSave } from '../hooks/useAutoSave';
import { useCollaborationSync } from '../collaboration';
import type { ImportContext } from '../services/FileImportService';

// Initialize connection notifications (runs once at module load)
initConnectionNotifications();

function App() {
  const initializeDefault = usePageStore((state) => state.initializeDefault);
  const persistenceInitializedRef = useRef(false);

  // Settings modal state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Command palette state (Cmd/Ctrl+K)
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);

  // Shape search state (Ctrl+F)
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  // Get rebuild function from document store
  const rebuildAllConnectorRoutes = useDocumentStore((state) => state.rebuildAllConnectorRoutes);

  // Split pane collapse state
  const [isEditorCollapsed, setIsEditorCollapsed] = useState(false);

  // Full-screen editor state
  const [isEditorFullscreen, setIsEditorFullscreen] = useState(false);

  // Import context from canvas engine
  const getImportContextRef = useRef<(() => ImportContext | null) | null>(null);

  const handleEngineReady = useCallback((getter: () => ImportContext | null) => {
    getImportContextRef.current = getter;
  }, []);

  const getImportContext = useCallback((): ImportContext | null => {
    return getImportContextRef.current?.() ?? null;
  }, []);

  // Auto-save hook
  useAutoSave();

  // Collaboration sync hook - enables bidirectional CRDT sync
  useCollaborationSync();

  // Open settings callback
  const handleOpenSettings = useCallback(() => {
    setIsSettingsOpen(true);
  }, []);

  const handleCloseSettings = useCallback(() => {
    setIsSettingsOpen(false);
  }, []);

  // Rebuild all connector routes callback
  const handleRebuildConnectors = useCallback(() => {
    if (rebuildAllConnectorRoutes) {
      rebuildAllConnectorRoutes();
    }
  }, [rebuildAllConnectorRoutes]);

  // Collapse handler for document editor panel
  const handleCollapseEditor = useCallback(() => {
    setIsEditorCollapsed(true);
  }, []);

  const handleCollapseChange = useCallback((collapsed: boolean) => {
    setIsEditorCollapsed(collapsed);
  }, []);

  // Full-screen toggle for document editor
  const handleToggleFullscreen = useCallback(() => {
    setIsEditorFullscreen((v) => !v);
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // Cmd/Ctrl+K — Command palette
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setIsPaletteOpen((v) => !v);
        return;
      }

      // Ctrl+F — Shape search
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setIsSearchOpen((v) => !v);
        return;
      }

      // F1 - Open documentation
      if (e.key === 'F1') {
        e.preventDefault();
        
        // Check if we're in Tauri environment
        const isTauri = typeof window !== 'undefined' && 
          '__TAURI_INTERNALS__' in window;
        
        if (isTauri) {
          try {
            const { openDocs } = await import('@/tauri/commands');
            await openDocs();
          } catch (error) {
            console.error('Failed to open docs via Tauri:', error);
            window.open('https://QR-Madness.github.io/diagrammer/', '_blank', 'noopener,noreferrer');
          }
        } else {
          window.open('https://QR-Madness.github.io/diagrammer/', '_blank', 'noopener,noreferrer');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Initialize persistence on mount
  useEffect(() => {
    if (persistenceInitializedRef.current) return;
    persistenceInitializedRef.current = true;

    // Warmup relay document cache from IndexedDB (async, non-blocking)
    useRelayDocumentStore.getState().warmupCache().catch(console.error);

    // Check if we have any saved documents
    const documents = usePersistenceStore.getState().documents;
    const hasDocuments = Object.keys(documents).length > 0;

    if (hasDocuments) {
      // Initialize from persistence (loads last document or creates new)
      initializePersistence();
    } else {
      // First time use: create default page (blank canvas)
      initializeDefault();

      // Set history active page
      const pageId = usePageStore.getState().activePageId;
      if (pageId) {
        useHistoryStore.getState().setActivePage(pageId);
      }
    }

    // One-shot bulk-mirror of existing local documents into the MCP
    // mirror so MCP clients can see docs created before this build (or
    // before the user toggled local access on). No-op outside Tauri or
    // when local access is disabled — the backend ignores mirror calls
    // in that case.
    void (async () => {
      try {
        const { isTauri, mcpGetLocalAccess, mcpMirrorLocalDocument } = await import(
          '@/tauri/commands'
        );
        if (!isTauri()) return;
        if (!(await mcpGetLocalAccess())) return;
        const docs = usePersistenceStore.getState().documents;
        for (const meta of Object.values(docs)) {
          const raw = localStorage.getItem(`diagrammer-doc-${meta.id}`);
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw);
            await mcpMirrorLocalDocument(parsed);
          } catch (e) {
            console.warn('MCP bulk-mirror skipped', meta.id, e);
          }
        }
      } catch (e) {
        console.warn('MCP bulk-mirror failed:', e);
      }
    })();
  }, [initializeDefault]);

  return (
    <div className="app">
      <ConnectionStatusBanner />
        <UnifiedToolbar
          onOpenSettings={handleOpenSettings}
          onRebuildConnectors={handleRebuildConnectors}
          getImportContext={getImportContext}
        />
        <main className="app-main">
          <SplitPane
            leftPanel={
              <ErrorBoundary sectionName="Document Editor">
                <DocumentEditorPanel
                  onCollapse={handleCollapseEditor}
                  isFullscreen={isEditorFullscreen}
                  onToggleFullscreen={handleToggleFullscreen}
                />
              </ErrorBoundary>
            }
            rightPanel={
              <>
                <CanvasContainer
                  className="canvas-area"
                  showGrid={true}
                  showFps={import.meta.env.DEV}
                  onEngineReady={handleEngineReady}
                />
                <ErrorBoundary sectionName="Properties">
                  <PropertyPanel />
                </ErrorBoundary>
                <ErrorBoundary sectionName="Layers">
                  <LayerPanel />
                </ErrorBoundary>
              </>
            }
            collapsed={isEditorCollapsed}
            onCollapseChange={handleCollapseChange}
          />
        </main>
        <StatusBar />

        {/* Presence indicators for collaboration */}
        <div className="app-presence">
          <PresenceIndicators size="small" />
        </div>

        {/* Settings Modal (includes Documents, Storage, etc.) */}
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={handleCloseSettings}
        />

        {/* Command Palette (Cmd/Ctrl+K) */}
        <CommandPalette isOpen={isPaletteOpen} onClose={() => setIsPaletteOpen(false)} />

        {/* Shape Search (Ctrl+F) */}
        <ShapeSearchPanel isOpen={isSearchOpen} onClose={() => setIsSearchOpen(false)} />

        {/* Whiteboard overlay (Ctrl+I) */}
        <Whiteboard />

      {/* Toast notifications */}
      <NotificationToast />
    </div>
  );
}

export default App;
