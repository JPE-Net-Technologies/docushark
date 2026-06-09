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
  FilePlus2,
  FolderOpen,
  HardDrive,
  Layers,
  LayoutGrid,
  List,
  Moon,
  Search,
  Settings as SettingsIcon,
  Sun,
  Trash2,
} from 'lucide-react';
import { useDocumentBrowserModel, SORT_LABELS } from '../settings/useDocumentBrowserModel';
import { DocumentList, SelectionBar } from '../settings/DocumentList';
import { StorageSettings } from '../settings/StorageSettings';
import { useThemeStore } from '../../store/themeStore';
import { blobStorage } from '../../storage/BlobStorage';
import type { StorageStats } from '../../storage/BlobTypes';
import { formatFileSize } from '../../utils/imageUtils';
import type { DocumentBrowserSort, DocumentBrowserView } from '../../store/uiPreferencesStore';
import './DocumentsHome.css';

export interface DocumentsHomeProps {
  /** Switch the app shell back to the editor (after opening/creating a doc, or "back"). */
  onLeaveToEditor: () => void;
  /** Open the Settings modal, optionally on a specific tab (cloud/storage management). */
  onOpenSettings?: (tab?: 'relay' | 'storage') => void;
}

type NavId = 'all' | 'recents' | 'local' | 'cloud' | 'cached';

const NAV_LABELS: Record<NavId, string> = {
  all: 'All documents',
  recents: 'Recents',
  local: 'Local',
  cloud: 'Cloud',
  cached: 'Offline',
};

export function DocumentsHome({ onLeaveToEditor, onOpenSettings }: DocumentsHomeProps) {
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
    isInTeamMode,
    isConnectedToHost,
    relaySessionUsable,
    currentUser,
    currentDocumentId,
    hasSelection,
    handleNewDocument,
  } = model;

  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const toggleTheme = useThemeStore((s) => s.toggle);

  // Active nav rail entry. Collection selection is tracked by the model
  // (`collectionFilter`); the type-axis entries map to `filterMode`.
  const [nav, setNav] = useState<NavId>('all');
  // Which destination the main area shows. Storage is a first-class view inside
  // the surface (JP-215), not a Settings tab.
  const [mainView, setMainView] = useState<'documents' | 'storage'>('documents');

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
  const quotaKnown = storage !== null && storage.available > 0;

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

  const signedIn = isConnectedToHost || relaySessionUsable;

  return (
    <div className="documents-home" data-theme={resolvedTheme}>
      {/* ── Sidebar ── */}
      <aside className="dh-side">
        <div className="dh-identity">
          <button
            className="dh-workspace"
            onClick={() => onOpenSettings?.('relay')}
            title={signedIn ? 'Manage cloud connection' : 'Sign in to DocuShark Cloud'}
          >
            <span className="dh-workspace-avatar">
              {signedIn ? <Cloud size={18} aria-hidden="true" /> : <HardDrive size={18} aria-hidden="true" />}
            </span>
            <span className="dh-workspace-info">
              <span className="dh-workspace-name">
                {signedIn ? (currentUser?.displayName ?? 'Cloud workspace') : 'Local workspace'}
              </span>
              <span className="dh-workspace-meta">
                {signedIn ? (isConnectedToHost ? 'Connected' : 'Signed in') : 'Sign in to sync'}
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

          {collections.length > 0 && (
            <>
              <div className="dh-nav-section">Collections</div>
              {collections.map((c) => (
                <button
                  key={c.id}
                  className={`dh-nav-item dh-collection${collectionFilter === c.id ? ' dh-nav-item--on' : ''}`}
                  onClick={() => selectCollection(c.id)}
                >
                  <span className="dh-collection-dot" style={c.color ? { background: c.color } : undefined} />
                  <span className="dh-nav-label">{c.name}</span>
                  <span className="dh-nav-count">{collectionCounts[c.id] ?? 0}</span>
                </button>
              ))}
            </>
          )}

          {/* Trash lights up once relay deletion signals (JP-175) land. */}
          <button className="dh-nav-item dh-nav-item--disabled" disabled title="Coming soon">
            <Trash2 size={17} aria-hidden="true" />
            <span className="dh-nav-label">Trash</span>
            <span className="dh-nav-soon">soon</span>
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
            {quotaKnown ? (
              <>
                <div className="dh-storage-bar">
                  <div
                    className="dh-storage-fill"
                    style={{ width: `${Math.min(100, storage!.percentUsed)}%` }}
                  />
                </div>
                <div className="dh-storage-meta">
                  {formatFileSize(storage!.used)} / {formatFileSize(storage!.available)} ·{' '}
                  {Math.round(storage!.percentUsed)}%
                </div>
              </>
            ) : (
              <div className="dh-storage-meta">
                {storage ? `${formatFileSize(storage.used)} used` : 'Calculating…'}
              </div>
            )}
          </button>

          <div className="dh-user">
            <span className="dh-user-avatar">
              {(currentUser?.displayName ?? 'You').slice(0, 1).toUpperCase()}
            </span>
            <span className="dh-user-info">
              <span className="dh-user-name">{currentUser?.displayName ?? 'You'}</span>
              <span className="dh-user-meta">{signedIn ? 'DocuShark Cloud' : 'Local only'}</span>
            </span>
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

          <section className="dh-section dh-section--list">
            <h2 className="dh-section-title">
              {searchQuery ? 'Results' : activeLabel}
              <span className="dh-section-count">
                {documentList.length} {documentList.length === 1 ? 'item' : 'items'}
              </span>
            </h2>
            <DocumentList model={model} onOpened={onLeaveToEditor} />
          </section>
        </div>
          </>
        )}
      </div>
    </div>
  );
}

export default DocumentsHome;
