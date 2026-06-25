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

import { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  Clock,
  Cloud,
  Database,
  ExternalLink,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Layers,
  LayoutGrid,
  List,
  Moon,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Shapes,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react';
import { useDocumentBrowserModel, SORT_LABELS } from '../settings/useDocumentBrowserModel';
import { DocumentList, SelectionBar } from '../settings/DocumentList';
import { CollectionActionsMenu } from '../settings/CollectionActionsMenu';
import { StorageSettings } from '../settings/StorageSettings';
import { TrashView } from './TrashView';
import { ShapeLibraryManager } from '../ShapeLibraryManager';
import { useTrashStore } from '../../store/trashStore';
import { useDocumentRegistry } from '../../store/documentRegistry';
import { useThemeStore } from '../../store/themeStore';
import { getDocProvider } from '../../store/relayDocumentStore';
import type { RelayUsage } from '../../api/relayClient';
import { loadConnection, DEFAULT_CLOUD_BASE_URL, WORKSPACE_URL_BASE } from '../../api/relayConnection';
import { opener } from '../../platform/opener';
import { blobStorage } from '../../storage/BlobStorage';
import type { StorageStats } from '../../storage/BlobTypes';
import { formatFileSize } from '../../utils/imageUtils';
import { openCloudSignIn } from '../cloud/cloudSignInStore';
import type {
  DocumentBrowserGroupBy,
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

type NavId = 'all' | 'recents' | 'local' | 'cloud' | 'cached';

const NAV_LABELS: Record<NavId, string> = {
  all: 'All documents',
  recents: 'Recents',
  local: 'Local',
  cloud: 'Cloud',
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
    isInTeamMode,
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

  const selectNav = (id: NavId) => {
    setNav(id);
    setMainView('documents');
    setCollectionFilter(null);
    if (id === 'recents') {
      setFilterMode('all');
      setSort('modified-desc');
    } else if (id === 'all') {
      setFilterMode('all');
    } else if (id === 'local') {
      setFilterMode('local');
    } else if (id === 'cloud') {
      setFilterMode('team');
    } else if (id === 'cached') {
      setFilterMode('cached');
    }
  };

  const selectCollection = (id: string) => {
    setMainView('documents');
    setFilterMode('all');
    setCollectionFilter(id);
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
  }, [signedIn]);

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

  // Cloud workspace identity (name + slug) for the workspace chip — the same
  // values the connect modal shows (JP-343), read from the persisted connection
  // record. Keyed on `signedIn`, NOT a status, so a REST-only sign-in (which
  // leaves connectionStore.status 'disconnected') still refreshes the display.
  const [wsName, setWsName] = useState<string | null>(null);
  const [wsSlug, setWsSlug] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadConnection().then((c) => {
      if (cancelled) return;
      setWsName(c?.workspaceName ?? null);
      setWsSlug(c?.workspaceSlug ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

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

  // "Continue working" strip: the most recent docs, shown on All without a query.
  const recents = useMemo(() => documentList.slice(0, 3), [documentList]);
  const showRecents = nav === 'all' && collectionFilter === null && !searchQuery && recents.length > 0;

  const activeLabel = collectionFilter
    ? (collections.find((c) => c.id === collectionFilter)?.name ?? 'Collection')
    : NAV_LABELS[nav];

  const navItems: { id: NavId; label: string; icon: typeof FolderOpen; count: number | null }[] = [
    { id: 'all', label: NAV_LABELS.all, icon: FolderOpen, count: documentCounts.total },
    { id: 'recents', label: NAV_LABELS.recents, icon: Clock, count: null },
    { id: 'local', label: NAV_LABELS.local, icon: HardDrive, count: documentCounts.local },
  ];
  if (isInTeamMode) {
    navItems.push({ id: 'cloud', label: NAV_LABELS.cloud, icon: Cloud, count: documentCounts.team });
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
      {/* ── Sidebar ── */}
      <aside className="dh-side">
        <div className="dh-identity">
          <button
            className="dh-workspace"
            onClick={() => openCloudSignIn()}
            title={signedIn ? 'Manage cloud connection' : 'Sign in to DocuShark Cloud'}
          >
            <span className="dh-workspace-avatar">
              {signedIn ? <Cloud size={18} aria-hidden="true" /> : <HardDrive size={18} aria-hidden="true" />}
            </span>
            <span className="dh-workspace-info">
              <span className="dh-workspace-name">
                {signedIn ? (wsName ?? 'Cloud workspace') : 'Local workspace'}
              </span>
              <span className="dh-workspace-meta">
                {signedIn
                  ? wsSlug
                    ? `${WORKSPACE_URL_BASE}/${wsSlug}`
                    : isConnectedToHost
                      ? 'Connected'
                      : 'Signed in'
                  : 'Sign in to sync'}
              </span>
            </span>
          </button>
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
            collections.map((c) => (
              <div
                key={c.id}
                className={`dh-collection-row${activeCollectionMenu === c.id ? ' dh-collection-row--menu-open' : ''}`}
              >
                <button
                  className={`dh-nav-item dh-collection${collectionFilter === c.id ? ' dh-nav-item--on' : ''}`}
                  onClick={() => selectCollection(c.id)}
                >
                  <span className="dh-collection-dot" style={c.color ? { background: c.color } : undefined} />
                  <span className="dh-nav-label">{c.name}</span>
                  <span className="dh-nav-count">{collectionCounts[c.id] ?? 0}</span>
                </button>
                <CollectionActionsMenu
                  collection={c}
                  isOpen={activeCollectionMenu === c.id}
                  onOpen={() => setActiveCollectionMenu(activeCollectionMenu === c.id ? null : c.id)}
                  onClose={() => setActiveCollectionMenu(null)}
                  onRename={handleRenameCollection}
                  onDelete={handleDeleteCollection}
                  onRecolor={handleRecolor}
                />
              </div>
            ))
          )}

          <button
            className={`dh-nav-item${mainView === 'shapes' ? ' dh-nav-item--on' : ''}`}
            onClick={() => setMainView('shapes')}
            title="Shape library"
            aria-current={mainView === 'shapes' ? 'page' : undefined}
          >
            <Shapes size={17} aria-hidden="true" />
            <span className="dh-nav-label">Shape library</span>
          </button>

          <button
            className={`dh-nav-item${mainView === 'trash' ? ' dh-nav-item--on' : ''}`}
            onClick={() => setMainView('trash')}
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
            onClick={() => setMainView('storage')}
            title="Manage storage"
          >
            <div className="dh-storage-top">
              <Database size={14} aria-hidden="true" />
              <span>Storage</span>
              <span className="dh-storage-manage">Manage</span>
            </div>
            <StorageMeter
              label="Local · this device"
              used={storage ? storage.used : null}
              quota={storage && storage.available > 0 ? storage.available : null}
              pending={storage === null}
            />
            {signedIn && (
              <StorageMeter
                label="Cloud workspace"
                used={relayUsage ? relayUsage.storageBytes : null}
                quota={relayUsage ? relayUsage.storageQuota : null}
                pending={relayUsage === null}
              />
            )}
          </button>

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
          <div className="dh-crumb">
            <strong>{activeLabel}</strong>
          </div>
          <div className="dh-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`Search ${activeLabel.toLowerCase()}…`}
            />
          </div>
          <div className="dh-top-actions">
            <label className="dh-sort">
              <span className="dh-sort-label">Sort</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as DocumentBrowserSort)}>
                {Object.entries(SORT_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="dh-sort">
              <span className="dh-sort-label">Group</span>
              <select
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value as DocumentBrowserGroupBy)}
                title="Group documents by collection"
              >
                <option value="none">None</option>
                <option value="collection">Collection</option>
              </select>
            </label>
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
            <button
              className="dh-import"
              onClick={handleImport}
              title="Import a .docushark document (with its assets)"
            >
              <Upload size={16} aria-hidden="true" />
              <span>Import</span>
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
                  <button
                    key={r.id}
                    className="dh-rcard"
                    onClick={async () => {
                      await model.handleOpen(r.id);
                      onLeaveToEditor();
                    }}
                  >
                    <span className="dh-rcard-ico">
                      <Layers size={18} aria-hidden="true" />
                    </span>
                    <span className="dh-rcard-meta">
                      <span className="dh-rcard-title">{r.name}</span>
                      <span className="dh-rcard-sub">
                        {r.type === 'local' ? 'Local' : r.type === 'cached' ? 'Offline' : 'Cloud'}
                      </span>
                    </span>
                  </button>
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
              <h2 className="dh-section-title">
                {searchQuery ? 'Results' : activeLabel}
                <span className="dh-section-count">
                  {documentList.length} {documentList.length === 1 ? 'item' : 'items'}
                </span>
              </h2>
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
 * One labelled storage meter (Local or Cloud). `quota === null` means the
 * total is unknown/unlimited — show "used" without a bar rather than a
 * misleading full/empty track (e.g. WebKitGTK reports 0 local quota, and an
 * unlimited cloud quota reports null).
 */
function StorageMeter({
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
  const pct = used !== null && quota !== null && quota > 0 ? Math.min(100, (used / quota) * 100) : null;
  const value = pending
    ? 'Calculating…'
    : used === null
      ? '—'
      : quota !== null && quota > 0
        ? `${formatFileSize(used)} / ${formatFileSize(quota)}`
        : `${formatFileSize(used)} used`;
  return (
    <div className="dh-storage-row">
      <div className="dh-storage-rowtop">
        <span className="dh-storage-rowlabel">{label}</span>
        <span className="dh-storage-rowval">{value}</span>
      </div>
      {pct !== null && (
        <div className="dh-storage-bar">
          <div className="dh-storage-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

export default DocumentsHome;
