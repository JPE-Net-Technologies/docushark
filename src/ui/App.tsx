import { useEffect, useRef, useState, useCallback } from 'react';
import './App.css';
import { CanvasContainer } from './CanvasContainer';
import { PropertyPanel } from './PropertyPanel';
import { LayerPanel } from './LayerPanel';
import { useActivePanelState, useActiveLayoutMode, useLayoutActions } from './layout/useLayout';
import { isFlyoutLayout } from './layout/modes';
import { FlyoutPanel } from './layout/FlyoutPanel';
import { PanelChromeWrapper } from './layout/PanelChromeWrapper';
import { DockedPanel } from './layout/DockedPanel';
import { DocumentToggleRail } from './layout/DocumentToggleRail';
import { LAYOUT_MODES } from './layout/types';
import { applyLayoutMode } from '../engine/CommandRegistry';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';
import { useSessionStore } from '../store/sessionStore';
import { isMacOS } from '../utils/platform';
import { TitleBar } from './chrome/TitleBar';
import { SettingsModal } from './SettingsModal';
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
import { useUserStore } from '../store/userStore';
import { useConnectionStore } from '../store/connectionStore';
import { isTauri, openDocs } from '../tauri/commands';
import {
  initTransferService,
  getTransferService,
} from '../services/DocumentTransferService';
import {
  loadDocumentFromStorage,
  saveDocumentToStorage,
} from '../store/persistenceStore';
import { getDocumentMetadata } from '../types/Document';
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
  const [settingsInitialTab, setSettingsInitialTab] = useState<'documents' | 'layout'>('documents');

  // Command palette state (Cmd/Ctrl+K)
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);

  // Shape search state (Ctrl+F)
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  // Get rebuild function from document store
  const rebuildAllConnectorRoutes = useDocumentStore((state) => state.rebuildAllConnectorRoutes);

  // Custom chrome opt-in — drives both the in-app TitleBar render and the
  // Tauri native-decoration toggle synced below. Force-disabled on macOS:
  // the traffic-light controls and unified titlebar are too tightly coupled
  // to native decorations for the cross-platform in-app TitleBar to be a
  // credible swap, and a synced/migrated `true` from another OS would
  // otherwise strip the native frame on Mac.
  const customChromePref = useUIPreferencesStore((s) => s.layout.customChrome);
  const customChrome = customChromePref && !isMacOS();

  // Layout-driven panel visibility. The store is the source of truth; switching
  // layouts (Step 4) or moving panels (Step 6) flows through here.
  const activeMode = useActiveLayoutMode();
  const documentPanelState = useActivePanelState('document');
  const propertiesPanelState = useActivePanelState('properties');
  const layersPanelState = useActivePanelState('layers');
  const layoutActions = useLayoutActions();
  const isDocumentVisible = documentPanelState.visible;
  const isPropertiesVisible = propertiesPanelState.visible;
  const isLayersVisible = layersPanelState.visible;
  // Properties panel uses the fly-out wrapper in Designer/Technician unless the
  // user has pinned it for this layout. Power keeps it docked; Relaxed hides
  // it (unless selection triggers the transient overlay — see below).
  const propertiesUsesFlyout =
    isPropertiesVisible && isFlyoutLayout(activeMode) && !propertiesPanelState.pinned;

  // Relaxed gets a railless, selection-triggered Properties overlay. The
  // selection size subscription drives mounting; FlyoutPanel's own
  // expandOnSelection then handles the slide-in/out within the mounted node.
  const selectionCount = useSessionStore((s) => s.selectedIds.size);
  const relaxedTransientProps =
    activeMode === 'relaxed' && !isPropertiesVisible && selectionCount > 0;
  const renderProperties = isPropertiesVisible || relaxedTransientProps;

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

  // Sync the Tauri native decorations to the customChrome preference. Hiding
  // decorations switches to our in-app TitleBar; restoring them swaps back to
  // the OS frame. Runs at mount and on every preference change.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { isTauri } = await import('../tauri/commands');
        if (!isTauri()) return;
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        if (cancelled) return;
        await getCurrentWindow().setDecorations(!customChrome);
        console.log(`[App] Tauri decorations set to ${!customChrome} (customChrome=${customChrome})`);
      } catch (err) {
        // Loud error so a missing capability doesn't fail silently again.
        console.error('[App] Failed to sync Tauri decorations:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customChrome]);

  // Collaboration sync hook - enables bidirectional CRDT sync
  useCollaborationSync();

  // Open settings callback
  const handleOpenSettings = useCallback(() => {
    setSettingsInitialTab('documents');
    setIsSettingsOpen(true);
  }, []);

  const handleOpenLayoutSettings = useCallback(() => {
    setSettingsInitialTab('layout');
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

  // Collapse handler for document editor panel — writes through to the layout
  // store so the change is scoped to the active layout's overrides and
  // persists per-doc.
  const handleCollapseEditor = useCallback(() => {
    layoutActions.setPanelVisible('document', false);
  }, [layoutActions]);

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

      // Ctrl/Cmd+Shift+1..4 — Switch layout
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        const idx = parseInt(e.key, 10) - 1;
        const mode = LAYOUT_MODES[idx];
        if (mode) applyLayoutMode(mode);
        return;
      }

      // F1 - Open documentation
      if (e.key === 'F1') {
        e.preventDefault();

        if (isTauri()) {
          try {
            await openDocs();
          } catch (error) {
            console.error('Failed to open docs via Tauri:', error);
            window.open('https://JPE-Net-Technologies.github.io/docushark/', '_blank', 'noopener,noreferrer');
          }
        } else {
          window.open('https://JPE-Net-Technologies.github.io/docushark/', '_blank', 'noopener,noreferrer');
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

    // Initialize the two-phase document transfer service. Reads/writes
    // localStorage directly so it can roll back without touching the
    // editor's current-doc state.
    initTransferService({
      loadDocument: (id) => loadDocumentFromStorage(id),
      saveDocument: (doc) => {
        saveDocumentToStorage(doc);
        const metadata = getDocumentMetadata(doc);
        usePersistenceStore.setState((state) => ({
          documents: { ...state.documents, [doc.id]: metadata },
        }));
      },
      getCurrentUser: () => {
        const user = useUserStore.getState().currentUser;
        if (!user?.id) return null;
        return {
          id: user.id,
          displayName: user.displayName || user.username || 'Unknown',
        };
      },
      saveToHost: async (doc) => {
        await useRelayDocumentStore.getState().saveToHost(doc);
      },
      deleteFromHost: (id) => useRelayDocumentStore.getState().deleteFromHost(id),
      isAuthenticated: () =>
        useConnectionStore.getState().status === 'authenticated' &&
        useRelayDocumentStore.getState().authenticated,
      updateMetadata: (docId, metadata) => {
        usePersistenceStore.setState((state) => ({
          documents: { ...state.documents, [docId]: metadata },
        }));
      },
    });

    // Reconcile any transfer that was interrupted by a crash/reload.
    getTransferService()
      ?.recoverPendingTransfer()
      .catch((err) => console.error('[App] Transfer recovery failed:', err));

    // Rescue any pre-v2 team documents into the local document store
    // (Tauri-only, one-shot, gated by a localStorage flag).
    void (async () => {
      try {
        const { runTeamDocumentMigration } = await import(
          '../migrations/teamDocumentMigration'
        );
        await runTeamDocumentMigration();
      } catch (err) {
        console.error('[App] Team-doc migration failed:', err);
      }
    })();

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

  }, [initializeDefault]);

  return (
    <div className="app">
      <ConnectionStatusBanner />
        {customChrome && <TitleBar />}
        <UnifiedToolbar
          onOpenSettings={handleOpenSettings}
          onOpenLayoutSettings={handleOpenLayoutSettings}
          onRebuildConnectors={handleRebuildConnectors}
          getImportContext={getImportContext}
        />
        <main className="app-main">
          {/* Document on left */}
          {isDocumentVisible && documentPanelState.dock === 'left' && (
            <PanelChromeWrapper panelId="document">
              <DockedPanel panelId="document" side="left" defaultWidth={320}>
                <ErrorBoundary sectionName="Document Editor">
                  <DocumentEditorPanel
                    onCollapse={handleCollapseEditor}
                    isFullscreen={isEditorFullscreen}
                    onToggleFullscreen={handleToggleFullscreen}
                  />
                </ErrorBoundary>
              </DockedPanel>
            </PanelChromeWrapper>
          )}

          {/* Properties on left */}
          {renderProperties && propertiesPanelState.dock === 'left' && (
            <PanelChromeWrapper panelId="properties">
              <ErrorBoundary sectionName="Properties">
                {propertiesUsesFlyout || relaxedTransientProps ? (
                  <FlyoutPanel
                    panelId="properties"
                    label="Properties"
                    icon={<span style={{ fontSize: 12, fontWeight: 700 }}>P</span>}
                    expandOnSelection
                    side="left"
                    showRail={!relaxedTransientProps}
                  >
                    <PropertyPanel className="property-panel-left-dock" />
                  </FlyoutPanel>
                ) : (
                  <PropertyPanel className="property-panel-left-dock" />
                )}
              </ErrorBoundary>
            </PanelChromeWrapper>
          )}

          {/* Canvas (always present, takes remaining space) */}
          <div className="canvas-area-wrapper">
            <CanvasContainer
              className="canvas-area"
              showGrid={true}
              showFps={import.meta.env.DEV}
              onEngineReady={handleEngineReady}
            />
            {!isDocumentVisible && (
              <DocumentToggleRail side={documentPanelState.dock} />
            )}
            {isLayersVisible && (
              <ErrorBoundary sectionName="Layers">
                <LayerPanel />
              </ErrorBoundary>
            )}
          </div>

          {/* Properties on right */}
          {renderProperties && propertiesPanelState.dock === 'right' && (
            <PanelChromeWrapper panelId="properties">
              <ErrorBoundary sectionName="Properties">
                {propertiesUsesFlyout || relaxedTransientProps ? (
                  <FlyoutPanel
                    panelId="properties"
                    label="Properties"
                    icon={<span style={{ fontSize: 12, fontWeight: 700 }}>P</span>}
                    expandOnSelection
                    side="right"
                    showRail={!relaxedTransientProps}
                  >
                    <PropertyPanel />
                  </FlyoutPanel>
                ) : (
                  <PropertyPanel />
                )}
              </ErrorBoundary>
            </PanelChromeWrapper>
          )}

          {/* Document on right */}
          {isDocumentVisible && documentPanelState.dock === 'right' && (
            <PanelChromeWrapper panelId="document">
              <DockedPanel panelId="document" side="right" defaultWidth={320}>
                <ErrorBoundary sectionName="Document Editor">
                  <DocumentEditorPanel
                    onCollapse={handleCollapseEditor}
                    isFullscreen={isEditorFullscreen}
                    onToggleFullscreen={handleToggleFullscreen}
                  />
                </ErrorBoundary>
              </DockedPanel>
            </PanelChromeWrapper>
          )}
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
          initialTab={settingsInitialTab}
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
