import { useEffect, useRef, useState, useCallback, lazy, Suspense } from 'react';
import './App.css';
import { CanvasContainer } from './CanvasContainer';
import { PropertyPanel } from './PropertyPanel';
import { LayerPanel } from './LayerPanel';
import { useActivePanelState, useActiveLayoutMode, useLayoutActions } from './layout/useLayout';
import { isFlyoutLayout, resolveRegions } from './layout/modes';
import { useBreakpoint } from './layout/useBreakpoint';
import { FlyoutPanel } from './layout/FlyoutPanel';
import { PanelChromeWrapper } from './layout/PanelChromeWrapper';
import { DockedPanel } from './layout/DockedPanel';
import { DocumentToggleRail } from './layout/DocumentToggleRail';
import { RelaxedSplitHandle } from './layout/RelaxedSplitHandle';
import { dispatchKey } from '../engine/CommandRegistry';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';
import { useSessionStore } from '../store/sessionStore';
import { isMacOS } from '../utils/platform';
import { TitleBar } from './chrome/TitleBar';
import { SettingsModal } from './SettingsModal';
import { DocumentsHome } from './home/DocumentsHome';
import { UnifiedToolbar } from './UnifiedToolbar';
import { CanvasToolbar } from './CanvasToolbar';
import { StatusBar } from './StatusBar';
import { FloatingCollabIndicator } from './FloatingCollabIndicator';
import { NotificationToast } from './NotificationToast';
import { ConfirmDialogHost } from './confirm/ConfirmDialog';
import { CloudSignInHost } from './cloud/CloudSignInHost';
import { openCloudSignIn } from './cloud/cloudSignInStore';
import { UploadIndicator } from './UploadIndicator';
import { ErrorBoundary } from './ErrorBoundary';
import { ConnectionStatusBanner } from './ConnectionStatusBanner';
import { registerNetworkStatusWatcher } from '../services/networkStatusWatcher';
import { CommandPalette } from './CommandPalette';
import { ShapeSearchPanel } from './ShapeSearchPanel';
import { Whiteboard } from './Whiteboard';
import { usePageStore } from '../store/pageStore';
import { useHistoryStore } from '../store/historyStore';
import {
  initializePersistence,
  usePersistenceStore,
  isRelayDocId,
  getLastOpenedDocId,
} from '../store/persistenceStore';
import { restoreCloudSession, notifyCloudSessionExpired } from '../api/restoreCloudSession';
import { useDocumentStore } from '../store/documentStore';
import { initConnectionNotifications } from '../store/connectionStore';
import { useRelayDocumentStore, isCloudSignedIn } from '../store/relayDocumentStore';
import { registerRelayListAutoRefresh } from '../services/relayListAutoRefresh';
import { useTrashStore } from '../store/trashStore';
import { ensureDocBlobsLocal } from '../store/offlineAvailability';
import { useUserStore } from '../store/userStore';
import { useConnectionStore } from '../store/connectionStore';
import { windowControls } from '../platform/window';
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
import { getSyncStateManager } from '../collaboration/SyncStateManager';
import type { ImportContext } from '../services/FileImportService';

// Lazy-load the rich-text editor panel so the tiptap stack (+ katex via
// LatexExtension, + nspell via SpellcheckService) is split out of the main
// bundle and only fetched when a document panel is actually shown.
const DocumentEditorPanel = lazy(() =>
  import('./DocumentEditorPanel').then((m) => ({ default: m.DocumentEditorPanel })),
);

// Initialize connection notifications (runs once at module load)
initConnectionNotifications();

function App({ authCallbackConsumed = false }: { authCallbackConsumed?: boolean } = {}) {
  const initializeDefault = usePageStore((state) => state.initializeDefault);
  const persistenceInitializedRef = useRef(false);

  // Settings modal state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'appearance'>('general');

  // Top-level app surface. The Documents "home" (JP-218) is a first-class
  // peer to the editor — full-bleed, reachable any time, and left by opening a
  // document. Not a modal: the editor stays mounted underneath so its state
  // survives the round trip.
  const [appView, setAppView] = useState<'editor' | 'documents'>('editor');

  // Command palette state (Cmd/Ctrl+K)
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);

  // Shape search state (Ctrl+F)
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  // Get rebuild function from document store
  const rebuildAllConnectorRoutes = useDocumentStore((state) => state.rebuildAllConnectorRoutes);

  // Custom chrome opt-in — drives both the in-app TitleBar render and the
  // Tauri native-decoration toggle synced below. Gated to the desktop shell:
  // `windowControls.isSupported()` is false on the PWA, so a persisted (or
  // legacy, pre-JP-107) `true` never renders a controls-less in-app TitleBar
  // on web. Force-disabled on macOS too: the traffic-light controls and
  // unified titlebar are too tightly coupled to native decorations for the
  // cross-platform in-app TitleBar to be a credible swap.
  const customChromePref = useUIPreferencesStore((s) => s.layout.customChrome);
  const customChrome = customChromePref && windowControls.isSupported() && !isMacOS();

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

  // Relaxed writing-first layout: the prose editor is the primary region and
  // `relaxedFocus` (plus the viewport band) decides how the canvas appears.
  // Other layouts ignore this and use the docked panel machinery below.
  const relaxedFocus = useSessionStore((s) => s.relaxedFocus);

  // Relaxed gets a railless, selection-triggered Properties overlay. The
  // selection size subscription drives mounting; FlyoutPanel's own
  // expandOnSelection then handles the slide-in/out within the mounted node.
  // Suppressed in `write` focus — the canvas is hidden there, so a lingering
  // selection must not pop the Properties overlay over the prose.
  const selectionCount = useSessionStore((s) => s.selectedIds.size);
  const relaxedTransientProps =
    activeMode === 'relaxed' &&
    relaxedFocus !== 'write' &&
    !isPropertiesVisible &&
    selectionCount > 0;
  const renderProperties = isPropertiesVisible || relaxedTransientProps;

  const { band } = useBreakpoint();
  const regions = resolveRegions(activeMode, relaxedFocus, band);
  const isRelaxed = activeMode === 'relaxed';
  // The canvas wrapper is rendered once for every layout (so the engine never
  // remounts on a layout switch). In Relaxed it becomes a resizable secondary
  // pane in split focus, or hides in write focus; elsewhere it stays dominant.
  const canvasIsSecondary = isRelaxed && regions.primary === 'document' && regions.split;
  const canvasIsHidden = isRelaxed && regions.primary === 'document' && !regions.split;
  const relaxedSplitCanvasWidth = useUIPreferencesStore((s) => s.relaxedSplitCanvasWidth);
  const canvasWrapperClass = [
    'canvas-area-wrapper',
    canvasIsSecondary && 'canvas-area-wrapper--secondary',
    canvasIsHidden && 'is-collapsed',
  ]
    .filter(Boolean)
    .join(' ');

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

  // Sync the native window decorations to the customChrome preference. Hiding
  // decorations switches to our in-app TitleBar; restoring them swaps back to
  // the OS frame. Runs at mount and on every preference change. No-op on web
  // (platform.window reports unsupported).
  useEffect(() => {
    windowControls
      .setDecorations(!customChrome)
      .then(() => {
        if (windowControls.isSupported()) {
          console.log(`[App] window decorations set to ${!customChrome} (customChrome=${customChrome})`);
        }
      })
      .catch((err) => {
        // Loud error so a missing capability doesn't fail silently again.
        console.error('[App] Failed to sync window decorations:', err);
      });
  }, [customChrome]);

  // Collaboration sync hook - enables bidirectional CRDT sync
  useCollaborationSync();

  // Open settings callback
  const handleOpenSettings = useCallback(() => {
    setSettingsInitialTab('general');
    setIsSettingsOpen(true);
  }, []);

  // Documents surface (JP-218) entry / exit.
  const handleOpenDocuments = useCallback(() => setAppView('documents'), []);
  const handleLeaveToEditor = useCallback(() => setAppView('editor'), []);

  const handleOpenLayoutSettings = useCallback(() => {
    setSettingsInitialTab('appearance');
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

  // Global keyboard shortcuts — the single window-level owner. Every global
  // binding (palette, search, documents, layout 1-4, relaxed focus, F1) lives in
  // the central registry; this just routes the event through it (the registry
  // owns preventDefault + the per-binding while-typing rule). React-state actions
  // (palette/search toggle, documents) are bridged back via CustomEvents below.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      dispatchKey(e, 'global');
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Bridge registry commands that need App's React state.
  useEffect(() => {
    const togglePalette = () => setIsPaletteOpen((v) => !v);
    const toggleSearch = () => setIsSearchOpen((v) => !v);
    window.addEventListener('docushark:toggle-command-palette', togglePalette);
    window.addEventListener('docushark:toggle-search', toggleSearch);
    return () => {
      window.removeEventListener('docushark:toggle-command-palette', togglePalette);
      window.removeEventListener('docushark:toggle-search', toggleSearch);
    };
  }, []);

  // The command palette can't reach React state directly; "Go to Documents"
  // dispatches an event (mirrors the import-diagram command). Listen for it.
  useEffect(() => {
    const open = () => setAppView('documents');
    window.addEventListener('docushark:open-documents', open);
    return () => window.removeEventListener('docushark:open-documents', open);
  }, []);

  // Open the Cloud sign-in modal, e.g. from the connection banner's "Reconnect"
  // (JP-237) or an expired-session notice. The modal portals over any view, so
  // there's no view switch — just pop the store open.
  useEffect(() => {
    const open = () => openCloudSignIn();
    window.addEventListener('docushark:open-cloud-connect', open);
    return () => window.removeEventListener('docushark:open-cloud-connect', open);
  }, []);

  // Drive the relay connection off the browser's online/offline events (JP-237)
  // so losing/regaining network reflects immediately instead of waiting on the
  // WebSocket's slow TCP timeout.
  useEffect(() => registerNetworkStatusWatcher(), []);

  // Refresh the team document list on regained focus / connectivity (JP-324
  // #10) so a doc transferred from another session appears without a manual
  // reload while sitting idle on a local/offline doc. Guarded + throttled in the
  // service; no-ops when signed out.
  useEffect(() => registerRelayListAutoRefresh(), []);

  // Initialize persistence on mount
  useEffect(() => {
    if (persistenceInitializedRef.current) return;
    persistenceInitializedRef.current = true;

    // Warmup relay document cache from IndexedDB (async, non-blocking)
    useRelayDocumentStore.getState().warmupCache().catch(console.error);

    // Sweep expired trash + reclaim its blobs, then surface what remains in the
    // bin for the Documents Trash view (JP-291). Non-blocking.
    void useTrashStore.getState().expireSweep().then(() => useTrashStore.getState().refresh());

    // Ask the browser to make our storage persistent so it won't evict the
    // offline sync queue / relay cache under storage pressure (PWA durability;
    // no-op / unsupported outside the browser). Best-effort, non-blocking.
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      void navigator.storage
        .persisted()
        .then((already) => (already ? undefined : navigator.storage.persist()))
        .catch(() => {});
    }

    // Wire the offline sync queue: durably persisted relay-doc saves made
    // while offline get replayed to the relay on reconnect (JP-106). The
    // manager auto-processes its queue when the connection becomes
    // authenticated; we give it a provider that pushes via the relay store.
    const syncManager = getSyncStateManager({ autoProcessOnReconnect: true });
    syncManager.setProvider({
      saveDocument: (doc, expectedVersion) =>
        useRelayDocumentStore.getState().saveToHost(doc, expectedVersion),
      deleteDocument: (id) => useRelayDocumentStore.getState().deleteFromHost(id),
      isReady: () =>
        useConnectionStore.getState().status === 'authenticated' &&
        useRelayDocumentStore.getState().authenticated,
    });
    syncManager.initialize().catch(console.error);

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
      saveToHost: async (doc, opts) => {
        await useRelayDocumentStore.getState().saveToHost(doc, undefined, opts);
      },
      deleteFromHost: (id) => useRelayDocumentStore.getState().deleteFromHost(id),
      ensureBlobsAvailableLocally: (doc) => ensureDocBlobsLocal(doc),
      // Transfer runs over the REST `saveToHost`, so a usable cloud session
      // (REST-only cached OR live WS) is sufficient — gating on the live WS
      // status blocked the first transfer after a REST-only sign-in.
      isAuthenticated: () => isCloudSignedIn(),
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

    // Boot auto-sign-in (Lean): actually USE the saved relay token on restart.
    // Run BEFORE opening the last doc so the token is live in the connection
    // store first. For a relay-doc boot, JP-324 Slice 1 brings up the full WS
    // session (and loads the list) when the doc reopens, so we only assert the
    // token (proactiveList: false). For a local/no-doc boot we additionally load
    // the live cloud list over REST (race-free — no WS/engine). Skipped on the
    // web-OAuth callback load, which already signed in.
    void (async () => {
      if (!authCallbackConsumed) {
        try {
          const bootRelay = isRelayDocId(getLastOpenedDocId());
          const result = await restoreCloudSession({ proactiveList: !bootRelay });
          if (result.status === 'expired') notifyCloudSessionExpired();
        } catch (err) {
          console.error('[App] Boot cloud-session restore failed:', err);
        }
      }

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
    })();

  }, [initializeDefault, authCallbackConsumed]);

  return (
    <div className="app">
      <ConnectionStatusBanner />
        {/* Custom-chrome title bar stays in the document browser — it carries the
            desktop window controls. The editor app bar (document title, layouts,
            export…) is editor-only, so it's hidden while the browser is open
            (DocumentsHome has its own chrome + Back-to-editor). */}
        {customChrome && <TitleBar />}
        {appView === 'editor' && (
          <UnifiedToolbar
            onOpenSettings={handleOpenSettings}
            onOpenLayoutSettings={handleOpenLayoutSettings}
            onOpenDocuments={handleOpenDocuments}
          />
        )}
        <main className="app-main">
          {/* Document on left. In Relaxed the editor is the primary reading
              column (not a fixed sidebar); the focus switch in the toolbar
              decides whether the canvas shows alongside it. Hidden — not
              unmounted — in diagram focus so editor state survives switches. */}
          {isDocumentVisible && documentPanelState.dock === 'left' && (
            isRelaxed ? (
              <div
                className={`document-area-wrapper${
                  regions.primary === 'canvas' ? ' is-collapsed' : ''
                }${canvasIsSecondary ? ' document-area-wrapper--split' : ''}`}
              >
                <ErrorBoundary sectionName="Document Editor">
                  <Suspense fallback={<div className="document-editor-loading" />}>
                    <DocumentEditorPanel
                      isFullscreen={isEditorFullscreen}
                      onToggleFullscreen={handleToggleFullscreen}
                      onCustomizeLayout={handleOpenLayoutSettings}
                      // Centered reading column when prose owns the full width
                      // (write); fill the pane edge-to-edge when sharing with
                      // the canvas (split).
                      presentation={regions.split ? 'docked' : 'reading'}
                    />
                  </Suspense>
                </ErrorBoundary>
              </div>
            ) : (
              <PanelChromeWrapper panelId="document">
                <DockedPanel panelId="document" side="left" defaultWidth={320}>
                  <ErrorBoundary sectionName="Document Editor">
                    <Suspense fallback={<div className="document-editor-loading" />}>
                      <DocumentEditorPanel
                        onCollapse={handleCollapseEditor}
                        isFullscreen={isEditorFullscreen}
                        onToggleFullscreen={handleToggleFullscreen}
                        onCustomizeLayout={handleOpenLayoutSettings}
                      />
                    </Suspense>
                  </ErrorBoundary>
                </DockedPanel>
              </PanelChromeWrapper>
            )
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

          {/* Canvas — always present (one mount across every layout). Sizing
              for the Relaxed secondary/hidden states comes from the class; in
              split focus the explicit width is user-draggable. */}
          <div
            className={canvasWrapperClass}
            // An explicit (dragged) width wins; when null the responsive
            // `.canvas-area-wrapper--secondary` CSS clamp owns the ~50/50 split.
            style={
              canvasIsSecondary && relaxedSplitCanvasWidth != null
                ? { flex: `0 0 ${relaxedSplitCanvasWidth}px` }
                : undefined
            }
          >
            {canvasIsSecondary && <RelaxedSplitHandle />}
            <ErrorBoundary sectionName="Canvas Toolbar">
              <CanvasToolbar
                getImportContext={getImportContext}
                onRebuildConnectors={handleRebuildConnectors}
              />
            </ErrorBoundary>
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
                  <Suspense fallback={<div className="document-editor-loading" />}>
                    <DocumentEditorPanel
                      onCollapse={handleCollapseEditor}
                      isFullscreen={isEditorFullscreen}
                      onToggleFullscreen={handleToggleFullscreen}
                      onCustomizeLayout={handleOpenLayoutSettings}
                    />
                  </Suspense>
                </ErrorBoundary>
              </DockedPanel>
            </PanelChromeWrapper>
          )}

          {/* Documents surface (JP-218) overlays the editor *content area* only,
              so the title bar + toolbar (and the window controls) stay above it
              and remain usable. The editor stays mounted underneath. */}
          {appView === 'documents' && (
            <DocumentsHome
              onLeaveToEditor={handleLeaveToEditor}
              onOpenSettings={handleOpenSettings}
            />
          )}
        </main>
        <StatusBar />

        {/* Floating, draggable collaboration indicator (JP-315). Hides itself
            when no remote collaborators are present. */}
        <FloatingCollabIndicator />

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
      <UploadIndicator />

      {/* Styled confirmation prompts (replaces window.confirm) */}
      <ConfirmDialogHost />

      {/* Cloud sign-in / workspace management modal (portaled over any view) */}
      <CloudSignInHost />
    </div>
  );
}

export default App;
