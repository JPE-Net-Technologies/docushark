/**
 * DocumentsHome — the first-class "Documents" surface (JP-218).
 *
 * Promotes document browsing out of the Settings modal into a full-bleed app
 * surface: a sidebar (identity, nav rail, collections, local storage, user) and
 * a main area (header, "Continue working" strip, document list). It wraps the
 * shared `useDocumentBrowserModel` engine — all document logic lives there; this
 * file is the chrome.
 *
 * Visual language follows the DocuShark brand kit (warm-paper / navy surfaces,
 * gold accents) via the tokens in `index.css`. The kit's web-only concepts
 * (multi-workspace switching, share links, collaborators) are intentionally
 * absent — this surfaces the editor's real model: local + cloud documents,
 * collections, and local storage.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronsUpDown,
  ChevronUp,
  Clock,
  Cloud,
  Database,
  ExternalLink,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  HardDrive,
  LayoutGrid,
  List,
  Menu,
  Moon,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Shapes,
  Sun,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import { useDocumentBrowserModel } from '../settings/useDocumentBrowserModel';
import { BrowserViewMenu } from './BrowserViewMenu';
import { DocumentList, SelectionBar } from '../settings/DocumentList';
import { CollectionActionsMenu } from '../settings/CollectionActionsMenu';
import { isWorkspaceCollection } from '../../store/collectionStore';
import { StorageSettings } from '../settings/StorageSettings';
import { TrashView } from './TrashView';
import { ShapeLibraryManager } from '../ShapeLibraryManager';
import { useTrashStore } from '../../store/trashStore';
import { useDocumentRegistry } from '../../store/documentRegistry';
import { useThemeStore } from '../../store/themeStore';
import { RecentCard } from './RecentCard';
import { getDocProvider } from '../../store/relayDocumentStore';
import type { RelayUsage } from '../../api/relayClient';
import { loadConnection, DEFAULT_CLOUD_BASE_URL } from '../../api/relayConnection';
import { RailWorkspaceSwitcher } from './RailWorkspaceSwitcher';
import { opener } from '../../platform/opener';
import { blobStorage } from '../../storage/BlobStorage';
import type { StorageStats } from '../../storage/BlobTypes';
import {
  formatStorageSize,
  formatStoragePair,
  storagePercent,
} from '../../utils/formatStorageSize';
import { CapacityRing, type CapacitySegment } from './CapacityRing';
import { openCloudSignIn } from '../cloud/cloudSignInStore';
import type {
  DocumentBrowserSort,
  DocumentBrowserView,
} from '../../store/uiPreferencesStore';
import './DocumentsHome.css';

export interface DocumentsHomeProps {
  /** Switch the app shell back to the editor (after opening/creating a doc, or "back"). */
  onLeaveToEditor: () => void;
  /** Open the (preferences) Settings modal. Cloud + storage now live in-surface. */
  onOpenSettings?: () => void;
}

type NavId = 'all' | 'recents' | 'local' | 'cloud' | 'shared' | 'cached';

const NAV_LABELS: Record<NavId, string> = {
  all: 'All documents',
  recents: 'Recents',
  local: 'Local',
  cloud: 'Cloud',
  shared: 'Shared with me',
  cached: 'Offline',
};

export function DocumentsHome({
  onLeaveToEditor,
  onOpenSettings,
}: DocumentsHomeProps) {
  const model = useDocumentBrowserModel();
  const {
    documentList,
    documentCounts,
    collections,
    assignments,
    collectionFilter,
    setCollectionFilter,
    setFilterMode,
    searchQuery,
    setSearchQuery,
    view,
    setView,
    sort,
    setSort,
    groupBy,
    setGroupBy,
    handleCreateCollection,
    handleRenameCollection,
    handleDeleteCollection,
    handleRecolor,
    activeCollectionMenu,
    setActiveCollectionMenu,
    isInRelayMode,
    isConnectedToHost,
    relaySessionUsable,
    currentDocumentId,
    hasSelection,
    handleNewDocument,
    handleImport,
    handleRefresh,
  } = model;
  const isFetchingRemote = useDocumentRegistry((s) => s.isFetchingRemote);

  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const toggleTheme = useThemeStore((s) => s.toggle);

  // Active nav rail entry. Collection selection is tracked by the model
  // (`collectionFilter`); the type-axis entries map to `filterMode`.
  const [nav, setNav] = useState<NavId>('all');
  // Which destination the main area shows. Storage (JP-215) is a first-class
  // view inside the surface, not a Settings tab. Cloud connect is now a modal
  // (cloudSignInStore) that floats over any view, not an in-surface page.
  const [mainView, setMainView] = useState<'documents' | 'storage' | 'trash' | 'shapes'>(
    'documents'
  );
  const [refreshSpin, setRefreshSpin] = useState(false);
  const trashCount = useTrashStore((s) => s.items.length);
  const refreshTrash = useTrashStore((s) => s.refresh);

  // `/` focuses the search box (JP-387) — classic library-surface shortcut.
  // Ignored while typing anywhere (input/textarea/contenteditable).
  // `Ctrl/Cmd+K` (JP-444) also focuses it — cross-tool muscle memory; skips
  // the typing guard, matching how command bars behave. Registered in the
  // CAPTURE phase with stopPropagation: Mod+K is the editor's command-palette
  // binding (CommandRegistry, window bubble listener), and while this surface
  // overlays the editor the library search must win — the palette's commands
  // target the canvas behind the overlay.
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        searchInputRef.current?.focus();
        return;
      }
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // On narrow viewports the sidebar is an off-canvas drawer (it overlays the
  // content rather than squeezing it). Open state only matters at <=640px — the
  // toggle + backdrop are display:none above that, where the rail is docked.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Close the drawer on Escape while it's open.
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sidebarOpen]);
  // Drop any lingering open state when the viewport grows past the drawer
  // breakpoint, so the docked rail never renders with a stale backdrop.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 641px)');
    const sync = () => {
      if (mq.matches) setSidebarOpen(false);
    };
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const selectNav = (id: NavId) => {
    setNav(id);
    setMainView('documents');
    setCollectionFilter(null);
    setSidebarOpen(false);
    if (id === 'recents') {
      setFilterMode('all');
      setSort('modified-desc');
    } else if (id === 'all') {
      setFilterMode('all');
    } else if (id === 'local') {
      setFilterMode('local');
    } else if (id === 'cloud') {
      setFilterMode('relay');
    } else if (id === 'shared') {
      setFilterMode('shared');
    } else if (id === 'cached') {
      setFilterMode('cached');
    }
  };

  const selectCollection = (id: string) => {
    setMainView('documents');
    setFilterMode('all');
    setCollectionFilter(id);
    setSidebarOpen(false);
  };

  // Switch the main destination and dismiss the mobile drawer in one go.
  const goMainView = (v: 'documents' | 'storage' | 'trash' | 'shapes') => {
    setMainView(v);
    setSidebarOpen(false);
  };

  // Per-collection counts (network-free, from the local assignment map).
  const collectionCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const cid of Object.values(assignments)) {
      if (cid) counts[cid] = (counts[cid] ?? 0) + 1;
    }
    return counts;
  }, [assignments]);

  const signedIn = isConnectedToHost || relaySessionUsable;

  // Local IndexedDB storage usage for the sidebar foot. navigator.storage
  // .estimate() returns 0 quota on WebKitGTK/Linux desktop — degrade to
  // "used only" rather than showing a misleading 0%/full bar.
  const [storage, setStorage] = useState<StorageStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    blobStorage
      .getStorageStats()
      .then((s) => {
        if (!cancelled) setStorage(s);
      })
      .catch(() => {
        /* best-effort; foot just hides the bar */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Cloud (relay) storage for the signed-in workspace — counts only, via the
  // same authed REST provider as document CRUD (`GET /api/v1/usage`). Distinct
  // from the local on-device cache above; surfaced as its own labelled meter.
  const [relayUsage, setRelayUsage] = useState<RelayUsage | null>(null);
  // Keyed on `mainView` too (JP-443): returning from the storage view — where
  // a document may have been moved to personal or deleted to free space —
  // re-polls, so the meter (and the at-cap callout) reflects the freed bytes.
  useEffect(() => {
    if (!signedIn) {
      setRelayUsage(null);
      return;
    }
    let cancelled = false;
    const provider = getDocProvider();
    void provider
      ?.getUsage?.()
      .then((u) => {
        if (!cancelled) setRelayUsage(u);
      })
      .catch(() => {
        if (!cancelled) setRelayUsage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, mainView]);

  // JP-443: the cloud workspace is at (or over) its storage quota — new
  // uploads and growing saves are being refused by the relay. Drives the
  // meter's over-state and the callout offering the ways out.
  const atCloudCap =
    relayUsage !== null &&
    relayUsage.storageQuota !== null &&
    relayUsage.storageQuota > 0 &&
    relayUsage.storageBytes >= relayUsage.storageQuota;

  // Cloud account portal URL (docushark-web). Seeded from the persisted
  // connection's cloud base, falling back to the default. The bottom-left user
  // card links here in the system browser.
  const [cloudBaseUrl, setCloudBaseUrl] = useState(DEFAULT_CLOUD_BASE_URL);
  useEffect(() => {
    let cancelled = false;
    void loadConnection().then((c) => {
      if (!cancelled && c?.cloudBaseUrl) setCloudBaseUrl(c.cloudBaseUrl);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const openWebAccount = () => {
    void opener.openExternalUrl(`${cloudBaseUrl.replace(/\/+$/, '')}/account`);
  };

  // Keep the Trash nav count accurate on open (other surfaces mutate the bin).
  useEffect(() => {
    refreshTrash();
  }, [refreshTrash]);

  // Self-heal the document list on open: reconcile local docs from the
  // authoritative index + refetch remote, so renames / transfers / out-of-band
  // changes show up without an extra edit (the list otherwise lags behind).
  useEffect(() => {
    handleRefresh();
  }, [handleRefresh]);

  // "Continue working" strip: the most recent docs, shown on All without a
  // query. Skipped for tiny libraries (≤4 docs) where it would just duplicate
  // the table below (JP-444).
  const recents = useMemo(() => documentList.slice(0, 6), [documentList]);
  // Grid view is excluded (JP-477): once the grid cards carry the same
  // thumbnails, the strip is the first six of the list rendered twice, one row
  // above itself. It still earns its place over the list view, where it's the
  // only visual representation on screen.
  const showRecents =
    view === 'list' &&
    nav === 'all' &&
    collectionFilter === null &&
    !searchQuery &&
    documentList.length > 4;

  const activeLabel = collectionFilter
    ? (collections.find((c) => c.id === collectionFilter)?.name ?? 'Collection')
    : NAV_LABELS[nav];

  const navItems: { id: NavId; label: string; icon: typeof FolderOpen; count: number | null }[] = [
    { id: 'all', label: NAV_LABELS.all, icon: FolderOpen, count: documentCounts.total },
    { id: 'recents', label: NAV_LABELS.recents, icon: Clock, count: null },
    { id: 'local', label: NAV_LABELS.local, icon: HardDrive, count: documentCounts.local },
  ];
  if (isInRelayMode) {
    navItems.push({ id: 'cloud', label: NAV_LABELS.cloud, icon: Cloud, count: documentCounts.relay });
    navItems.push({ id: 'shared', label: NAV_LABELS.shared, icon: Users, count: documentCounts.shared });
    if (documentCounts.cached > 0) {
      navItems.push({ id: 'cached', label: NAV_LABELS.cached, icon: Database, count: documentCounts.cached });
    }
  }

  const onNew = () => {
    handleNewDocument();
    onLeaveToEditor();
  };

  return (
    <div className="documents-home" data-theme={resolvedTheme}>
      {/* Mobile-only drawer toggle — display:none above the drawer breakpoint. */}
      <button
        className="dh-menu-toggle"
        onClick={() => setSidebarOpen((v) => !v)}
        aria-label={sidebarOpen ? 'Close navigation' : 'Open navigation'}
        aria-expanded={sidebarOpen}
      >
        <Menu size={20} aria-hidden="true" />
      </button>

      {/* ── Sidebar ── */}
      <aside className={`dh-side${sidebarOpen ? ' dh-side--open' : ''}`}>
        <div className="dh-identity">
          <RailWorkspaceSwitcher
            signedIn={signedIn}
            isConnectedToHost={isConnectedToHost}
            onOpenWebAccount={openWebAccount}
          />
          <button
            className="dh-manage"
            onClick={() => onOpenSettings?.()}
            title="Settings"
            aria-label="Settings"
          >
            <SettingsIcon size={16} aria-hidden="true" />
          </button>
        </div>

        <nav className="dh-nav">
          {navItems.map((n) => {
            const Icon = n.icon;
            const active = collectionFilter === null && nav === n.id;
            return (
              <button
                key={n.id}
                className={`dh-nav-item${active ? ' dh-nav-item--on' : ''}`}
                onClick={() => selectNav(n.id)}
              >
                <Icon size={17} aria-hidden="true" />
                <span className="dh-nav-label">{n.label}</span>
                {n.count != null && <span className="dh-nav-count">{n.count}</span>}
              </button>
            );
          })}

          <div className="dh-nav-section dh-nav-section--with-action">
            <span>Collections</span>
            <button
              className="dh-nav-add"
              onClick={() => void handleCreateCollection()}
              title="New collection"
              aria-label="New collection"
            >
              <FolderPlus size={14} aria-hidden="true" />
            </button>
          </div>
          {collections.length === 0 ? (
            <div className="dh-nav-empty">No collections yet</div>
          ) : (
            collections.map((c) => {
              // Namespace the rail's menu key so it never collides with the
              // group-by-collection section menu (which keys off the bare
              // collection id) — otherwise both would open at once and their
              // outside-click handlers cancel each other (JP-380).
              const menuKey = `coll-rail:${c.id}`;
              const isWorkspace = isWorkspaceCollection(c);
              const ScopeIcon = isWorkspace ? Cloud : HardDrive;
              return (
                <div
                  key={c.id}
                  className={`dh-collection-row${activeCollectionMenu === menuKey ? ' dh-collection-row--menu-open' : ''}`}
                >
                  <button
                    className={`dh-nav-item dh-collection${collectionFilter === c.id ? ' dh-nav-item--on' : ''}`}
                    onClick={() => selectCollection(c.id)}
                  >
                    <span className="dh-collection-dot" style={c.color ? { background: c.color } : undefined} />
                    <ScopeIcon
                      size={13}
                      className="dh-collection-scope"
                      aria-label={isWorkspace ? 'Workspace collection' : 'Local collection'}
                    />
                    <span className="dh-nav-label">{c.name}</span>
                    <span className="dh-nav-count">{collectionCounts[c.id] ?? 0}</span>
                  </button>
                  <CollectionActionsMenu
                    collection={c}
                    isOpen={activeCollectionMenu === menuKey}
                    onOpen={() => setActiveCollectionMenu(activeCollectionMenu === menuKey ? null : menuKey)}
                    onClose={() => setActiveCollectionMenu(null)}
                    onRename={handleRenameCollection}
                    onDelete={handleDeleteCollection}
                    onRecolor={handleRecolor}
                  />
                </div>
              );
            })
          )}

          <button
            className={`dh-nav-item${mainView === 'shapes' ? ' dh-nav-item--on' : ''}`}
            onClick={() => goMainView('shapes')}
            title="Shape library"
            aria-current={mainView === 'shapes' ? 'page' : undefined}
          >
            <Shapes size={17} aria-hidden="true" />
            <span className="dh-nav-label">Shape library</span>
          </button>

          <button
            className={`dh-nav-item${mainView === 'trash' ? ' dh-nav-item--on' : ''}`}
            onClick={() => goMainView('trash')}
            title="Trash"
            aria-current={mainView === 'trash' ? 'page' : undefined}
          >
            <Trash2 size={17} aria-hidden="true" />
            <span className="dh-nav-label">Trash</span>
            {trashCount > 0 && <span className="dh-nav-count">{trashCount}</span>}
          </button>
        </nav>

        <div className="dh-side-foot">
          <button
            className={`dh-storage${mainView === 'storage' ? ' dh-storage--on' : ''}`}
            onClick={() => goMainView('storage')}
            title="Manage storage"
          >
            {/* The ring reports whichever store is the one that can actually
                run out: the cloud workspace when signed in, otherwise the
                device. The other becomes a one-line footnote — two full meters
                is one more than the rail has room for. The scope doubles as the
                card's eyebrow, so there's no separate "Storage" header row for
                it to contradict. */}
            {signedIn ? (
              <>
                <StorageHeadline
                  scope="Cloud workspace"
                  used={relayUsage ? relayUsage.storageBytes : null}
                  quota={relayUsage ? relayUsage.storageQuota : null}
                  pending={relayUsage === null}
                  over={atCloudCap}
                  shares={resolveShares(relayUsage)}
                />
                <StorageFootnote
                  label="This device"
                  used={storage ? storage.used : null}
                  quota={storage && storage.available > 0 ? storage.available : null}
                  pending={storage === null}
                />
              </>
            ) : (
              <StorageHeadline
                scope="This device"
                used={storage ? storage.used : null}
                quota={storage && storage.available > 0 ? storage.available : null}
                pending={storage === null}
              />
            )}
          </button>

          {signedIn && atCloudCap && (
            <div className="dh-cap-note" role="status">
              <span className="dh-cap-note-text">
                Cloud storage is full. Move a document to this device or delete
                files to free space.
              </span>
              <span className="dh-cap-note-actions">
                <button className="dh-cap-note-btn" onClick={() => goMainView('storage')}>
                  Manage
                </button>
                <button className="dh-cap-note-btn" onClick={openWebAccount}>
                  Account
                </button>
              </span>
            </div>
          )}

          <div className="dh-user">
            <button
              className="dh-user-main"
              onClick={openWebAccount}
              title="Open your DocuShark Cloud account"
            >
              <span className="dh-user-avatar">
                {signedIn ? <Cloud size={16} aria-hidden="true" /> : <HardDrive size={16} aria-hidden="true" />}
              </span>
              <span className="dh-user-info">
                {/* No account id / email here — the relay token's `sub` is an
                    opaque UID, not a friendly name. Show the account context +
                    the action; the external-link icon signals it opens the web. */}
                <span className="dh-user-name">{signedIn ? 'DocuShark Cloud' : 'Local only'}</span>
                <span className="dh-user-meta">Open web account</span>
              </span>
              <ExternalLink className="dh-user-ext" size={14} aria-hidden="true" />
            </button>
            <button
              className="dh-user-theme"
              onClick={toggleTheme}
              title={resolvedTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              aria-label={resolvedTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {resolvedTheme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
            </button>
          </div>
        </div>
      </aside>

      {/* Drawer backdrop — only rendered (and only styled) while open on narrow. */}
      {sidebarOpen && (
        <div
          className="dh-side-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── Main ── */}
      <div className="dh-main">
        {mainView === 'storage' ? (
          <>
            <header className="dh-top">
              <button className="dh-back" onClick={() => setMainView('documents')} title="Back to documents">
                <ChevronLeft size={18} aria-hidden="true" />
                <span>Documents</span>
              </button>
              <div className="dh-crumb">
                <strong>Storage</strong>
              </div>
            </header>
            <div className="dh-content dh-content--storage">
              <StorageSettings />
            </div>
          </>
        ) : mainView === 'shapes' ? (
          <>
            <header className="dh-top">
              <button className="dh-back" onClick={() => setMainView('documents')} title="Back to documents">
                <ChevronLeft size={18} aria-hidden="true" />
                <span>Documents</span>
              </button>
              <div className="dh-crumb">
                <strong>Shape library</strong>
              </div>
            </header>
            <div className="dh-content dh-content--shapes">
              <ShapeLibraryManager />
            </div>
          </>
        ) : mainView === 'trash' ? (
          <TrashView onBack={() => setMainView('documents')} />
        ) : (
          <>
        <header className="dh-top">
          {currentDocumentId && (
            <button className="dh-back" onClick={onLeaveToEditor} title="Back to editor">
              <ChevronLeft size={18} aria-hidden="true" />
              <span>Editor</span>
            </button>
          )}
          {/* Title carries the count, so the list below doesn't repeat it in a
              heading of its own. */}
          <div className="dh-crumb">
            <strong>{activeLabel}</strong>
            <span className="dh-crumb-count">
              {documentList.length} {documentList.length === 1 ? 'item' : 'items'}
            </span>
          </div>
          <div className="dh-search">
            <Search size={16} aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`Search ${activeLabel.toLowerCase()}…`}
              title="Search by name or tag — #tag matches tags only. Press / or Ctrl+K to focus."
            />
            <kbd className="dh-search-kbd" aria-hidden="true">/</kbd>
          </div>
          {/* Two clusters, not one undifferentiated row: how the library is
              displayed (view · sort/group · refresh), then what you do to it
              (import · new). The rule between them is the hierarchy. */}
          <div className="dh-top-actions">
            <div className="dh-top-utils">
              <div className="dh-view-toggle" role="group" aria-label="View mode">
                <button
                  className={view === 'list' ? 'on' : ''}
                  onClick={() => setView('list' as DocumentBrowserView)}
                  title="List view"
                  aria-label="List view"
                  aria-pressed={view === 'list'}
                >
                  <List size={16} aria-hidden="true" />
                </button>
                <button
                  className={view === 'grid' ? 'on' : ''}
                  onClick={() => setView('grid' as DocumentBrowserView)}
                  title="Grid view"
                  aria-label="Grid view"
                  aria-pressed={view === 'grid'}
                >
                  <LayoutGrid size={16} aria-hidden="true" />
                </button>
              </div>
              <BrowserViewMenu
                view={view}
                sort={sort}
                setSort={setSort}
                groupBy={groupBy}
                setGroupBy={setGroupBy}
              />
              <button
                className="dh-refresh"
                onClick={() => {
                  setRefreshSpin(true);
                  handleRefresh();
                  window.setTimeout(() => setRefreshSpin(false), 600);
                }}
                title="Refresh document list"
                aria-label="Refresh document list"
              >
                <RefreshCw
                  size={16}
                  aria-hidden="true"
                  className={isFetchingRemote || refreshSpin ? 'dh-refresh-spin' : undefined}
                />
              </button>
            </div>
            <span className="dh-top-rule" aria-hidden="true" />
            <button
              className="dh-import"
              onClick={handleImport}
              title="Import a .docushark document (with its assets)"
            >
              <Upload size={16} aria-hidden="true" />
              <span className="dh-import-label">Import</span>
            </button>
            <button className="dh-new" onClick={onNew} title="New document">
              <FilePlus2 size={16} aria-hidden="true" />
              <span>New</span>
            </button>
          </div>
        </header>

        <div className="dh-content">
          {showRecents && (
            <section className="dh-section">
              <h2 className="dh-section-title">
                <Clock size={15} aria-hidden="true" /> Continue working
              </h2>
              <div className="dh-recents">
                {recents.map((r) => (
                  <RecentCard
                    key={r.id}
                    record={r}
                    accent={model.accentByDoc.get(r.id)}
                    onOpen={async () => {
                      await model.handleOpen(r.id);
                      onLeaveToEditor();
                    }}
                  />
                ))}
              </div>
            </section>
          )}

          {hasSelection && <SelectionBar model={model} />}

          {nav === 'cloud' && !signedIn ? (
            <section className="dh-section dh-cloud-empty">
              <Cloud size={28} aria-hidden="true" />
              <p className="dh-cloud-empty-text">
                Sign in with DocuShark Cloud to sync your documents across devices.
              </p>
              <button className="dh-new" onClick={() => openCloudSignIn()}>
                <Cloud size={16} aria-hidden="true" />
                <span>Sign in with DocuShark Cloud</span>
              </button>
            </section>
          ) : (
            <section className="dh-section dh-section--list">
              {/* No heading here — the header's title + count already name this
                  list. A search gets one, because "Results" is the only case
                  where the list is no longer what the header says it is. */}
              {searchQuery && <h2 className="dh-section-title">Results</h2>}
              {view === 'list' && documentList.length > 0 && (
                <ColumnHeader sort={sort} setSort={setSort} />
              )}
              <DocumentList model={model} onOpened={onLeaveToEditor} />
            </section>
          )}
        </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Sortable column header over the list view (JP-444). Tracks (widths) are the
 * shared `--dh-col-*` variables the DocumentCard row cells consume, so header
 * and cells stay aligned by construction. Clicking a header toggles that
 * axis's direction; People is display-only (no meaningful order).
 */
type SortAxis = 'name' | 'modified' | 'size';

const SORT_CYCLES: Record<SortAxis, [DocumentBrowserSort, DocumentBrowserSort]> = {
  name: ['name-asc', 'name-desc'],
  modified: ['modified-desc', 'modified-asc'],
  size: ['size-desc', 'size-asc'],
};

function sortDir(sort: DocumentBrowserSort, axis: SortAxis): 'asc' | 'desc' | null {
  if (sort === `${axis}-asc`) return 'asc';
  if (sort === `${axis}-desc`) return 'desc';
  return null;
}

function SortGlyph({ dir }: { dir: 'asc' | 'desc' | null }) {
  if (dir === 'asc') return <ChevronUp size={12} aria-hidden="true" />;
  if (dir === 'desc') return <ChevronDown size={12} aria-hidden="true" />;
  return <ChevronsUpDown size={12} className="dh-colhead-glyph-idle" aria-hidden="true" />;
}

function ColumnHeader({
  sort,
  setSort,
}: {
  sort: DocumentBrowserSort;
  setSort: (sort: DocumentBrowserSort) => void;
}) {
  const toggle = (axis: SortAxis) => {
    const [first, second] = SORT_CYCLES[axis];
    setSort(sort === first ? second : first);
  };
  const ariaSort = (axis: SortAxis): 'ascending' | 'descending' | undefined => {
    const dir = sortDir(sort, axis);
    return dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined;
  };
  return (
    <div className="dh-colhead" role="row">
      <button
        className="dh-colhead-col dh-colhead-name"
        onClick={() => toggle('name')}
        aria-sort={ariaSort('name')}
      >
        Name <SortGlyph dir={sortDir(sort, 'name')} />
      </button>
      <button
        className="dh-colhead-col dh-colhead-time"
        onClick={() => toggle('modified')}
        aria-sort={ariaSort('modified')}
      >
        Last edited <SortGlyph dir={sortDir(sort, 'modified')} />
      </button>
      <span className="dh-colhead-col dh-colhead-people">People</span>
      <button
        className="dh-colhead-col dh-colhead-size"
        onClick={() => toggle('size')}
        aria-sort={ariaSort('size')}
      >
        Size <SortGlyph dir={sortDir(sort, 'size')} />
      </button>
      <span className="dh-colhead-tail" aria-hidden="true" />
    </div>
  );
}

/**
 * One labelled storage meter (Local or Cloud). `quota === null` means the
 * total is unknown/unlimited — show "used" without a bar rather than a
 * misleading full/empty track (e.g. WebKitGTK reports 0 local quota, and an
 * unlimited cloud quota reports null).
 */
/** The three metered shares of a cloud workspace, when the relay reports them. */
export interface StorageShares {
  docBytes: number;
  blobBytes: number;
  configBytes: number;
}

/**
 * The share breakdown for the meter, or `null` when it can't be shown honestly.
 *
 * Requires every share to be present AND to actually sum to the headline
 * number. A relay that predates one of them reports a subset, and rendering a
 * partial split would draw segments that visibly fall short of the total the
 * label states — worse than no breakdown at all. The single-fill bar is the
 * correct fallback, not a bug.
 */
export function resolveShares(usage: RelayUsage | null): StorageShares | null {
  if (!usage) return null;
  const { docBytes, blobBytes, configBytes } = usage;
  if (typeof docBytes !== 'number' || typeof blobBytes !== 'number') return null;
  const config = typeof configBytes === 'number' ? configBytes : 0;
  if (docBytes + blobBytes + config !== usage.storageBytes) return null;
  return { docBytes, blobBytes, configBytes: config };
}

/**
 * The rail's primary storage readout: a `CapacityRing` beside the scope and the
 * used/allowance pair.
 *
 * The JP-301 share breakdown is still here — it's drawn as the ring's arcs, and
 * the named byte counts moved to this element's tooltip (and the full Storage
 * view, one click away). That was the trade for a card that no longer wraps its
 * legend onto a second line.
 */
function StorageHeadline({
  scope,
  used,
  quota,
  pending,
  over = false,
  shares = null,
}: {
  scope: string;
  used: number | null;
  quota: number | null;
  pending: boolean;
  /** At/over quota (JP-443) — renders the ring in the danger color. */
  over?: boolean;
  /** Per-category breakdown (JP-301), when the relay reports one that sums. */
  shares?: StorageShares | null;
}) {
  const segments: CapacitySegment[] | null = shares
    ? [
        { key: 'docs', label: 'Documents', bytes: shares.docBytes },
        { key: 'files', label: 'Files', bytes: shares.blobBytes },
        { key: 'config', label: 'Configuration', bytes: shares.configBytes },
      ]
    : null;

  const value = pending ? 'Calculating…' : used === null ? '—' : formatStoragePair(used, quota);

  // Named shares live here rather than in a permanent legend. Configuration
  // gets its plain-language gloss appended — it's the one share whose name
  // doesn't explain itself.
  const tooltip = segments
    ? segments
        .map((s) => `${s.label}: ${formatStorageSize(s.bytes)}`)
        .concat('Configuration is your synced style profiles.')
        .join('\n')
    : undefined;

  return (
    <div className="dh-storage-main" title={tooltip}>
      <CapacityRing
        used={used}
        quota={quota}
        segments={segments}
        over={over}
        pending={pending}
        size={46}
      />
      <span className="dh-storage-readout">
        <span className="dh-storage-scope-row">
          <span className="dh-storage-scope">{scope}</span>
          <span className="dh-storage-manage">Manage</span>
        </span>
        <span className={`dh-storage-value${over ? ' dh-storage-value--over' : ''}`}>{value}</span>
      </span>
    </div>
  );
}

/**
 * The secondary store, as one quiet line.
 *
 * It carries a bar only once it's half full — below that the bar is a sliver of
 * noise reporting a non-problem, and `navigator.storage.estimate()` reports no
 * quota at all on WebKitGTK, where a drawn track would be a fabrication.
 */
function StorageFootnote({
  label,
  used,
  quota,
  pending,
}: {
  label: string;
  used: number | null;
  quota: number | null;
  pending: boolean;
}) {
  const pct = storagePercent(used ?? 0, quota);
  const value = pending ? 'Calculating…' : used === null ? '—' : formatStorageSize(used);
  const showBar = !pending && pct !== null && pct >= 50;

  return (
    <div className="dh-storage-foot">
      <span className="dh-storage-foot-row">
        <HardDrive size={12} aria-hidden="true" />
        <span className="dh-storage-foot-label">{label}</span>
        <span className="dh-storage-foot-val">{value}</span>
      </span>
      {showBar && (
        <span className="dh-storage-foot-bar">
          <span className="dh-storage-foot-fill" style={{ width: `${pct}%` }} />
        </span>
      )}
    </div>
  );
}

export default DocumentsHome;
