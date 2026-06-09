/**
 * DocumentBrowser component
 *
 * Unified document browser that combines local and remote document management.
 * This is the legacy Settings-tab chrome around the shared
 * `useDocumentBrowserModel` engine; the first-class `DocumentsHome` surface
 * (JP-218) wraps the same model with its own chrome. All document logic lives
 * in the model + `DocumentList`; this file is presentation only.
 *
 * Phase 14.1.6 UI Consolidation, Phase 20: collections, grid view, multi-select.
 */

import { lazy, Suspense } from 'react';
import {
  Download,
  FileText,
  LayoutGrid,
  List,
  Plus,
  RefreshCw,
  Save,
  Upload,
} from 'lucide-react';
import {
  type DocumentBrowserSort,
  type DocumentBrowserGroupBy,
  type DocumentBrowserView,
} from '../../store/uiPreferencesStore';
import { SyncStatusBadge } from '../SyncStatusBadge';
import { DocumentPermissionsDialog } from '../DocumentPermissionsDialog';
import { useDocumentBrowserModel, SORT_LABELS } from './useDocumentBrowserModel';
import { DocumentList, SelectionBar } from './DocumentList';

// Lazy: the PDF export dialog pulls jspdf + html2canvas + tiptap extensions —
// load that chunk only when the dialog is opened.
const PDFExportDialog = lazy(() =>
  import('../PDFExportDialog').then((m) => ({ default: m.PDFExportDialog })),
);
import { isTransferRunning, transferPhaseLabel } from '../../store/transferStore';

interface DocumentBrowserProps {
  /** Compact mode for sidebar usage */
  compact?: boolean;
}

export function DocumentBrowser({ compact = false }: DocumentBrowserProps) {
  const model = useDocumentBrowserModel();
  const {
    documentCounts,
    filterMode,
    setFilterMode,
    searchQuery,
    setSearchQuery,
    view,
    sort,
    groupBy,
    setView,
    setSort,
    setGroupBy,
    hasSelection,
    pdfExportOpen,
    setPdfExportOpen,
    permissionsDocId,
    setPermissionsDocId,
    isInTeamMode,
    isConnectedToHost,
    isHost,
    error,
    isLoading,
    transferPhase,
    transferDirection,
    handleNewDocument,
    handleSave,
    handleRefresh,
    handleImport,
    handleExport,
    handleCreateCollection,
  } = model;

  return (
    <div className={`document-browser ${compact ? 'document-browser--compact' : ''}`}>
      {/* JP-212: at-a-glance library summary (total + Personal/Team/Offline). */}
      <div
        className="document-browser__summary"
        role="status"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px 14px',
          padding: '4px 2px 8px',
          fontSize: 13,
          opacity: 0.85,
        }}
      >
        <span>
          <strong>{documentCounts.total}</strong> document{documentCounts.total === 1 ? '' : 's'}
        </span>
        {documentCounts.local > 0 && <span>{documentCounts.local} personal</span>}
        {documentCounts.team > 0 && <span>{documentCounts.team} team</span>}
        {documentCounts.cached > 0 && <span>{documentCounts.cached} offline</span>}
      </div>

      {/* Quick Actions */}
      <div className="document-browser__actions">
        <button
          className="document-browser__action document-browser__action--primary"
          onClick={handleNewDocument}
          title="Create new document"
        >
          <span className="document-browser__action-icon">
            <Plus size={18} aria-hidden="true" />
          </span>
          New
        </button>
        <button className="document-browser__action" onClick={handleSave} title="Save current document">
          <span className="document-browser__action-icon">
            <Save size={18} aria-hidden="true" />
          </span>
          Save
        </button>
        <button className="document-browser__action" onClick={handleImport} title="Import .docushark file">
          <span className="document-browser__action-icon">
            <Upload size={18} aria-hidden="true" />
          </span>
          Import
        </button>
        <button className="document-browser__action" onClick={handleExport} title="Export as .docushark">
          <span className="document-browser__action-icon">
            <Download size={18} aria-hidden="true" />
          </span>
          Export
        </button>
        <button className="document-browser__action" onClick={() => setPdfExportOpen(true)} title="Export as PDF">
          <span className="document-browser__action-icon">
            <FileText size={18} aria-hidden="true" />
          </span>
          PDF
        </button>
      </div>

      {/* Transfer progress (Local ↔ Cloud) */}
      {isTransferRunning(transferPhase) && (
        <div className="document-browser__transfer" role="status">
          <SyncStatusBadge state="syncing" showLabel={false} size="small" />
          <span className="document-browser__transfer-text">
            {transferPhaseLabel(transferDirection, transferPhase)}
          </span>
        </div>
      )}

      {/* Connection Status */}
      {isInTeamMode && (
        <div className="document-browser__status">
          {isConnectedToHost ? (
            <>
              <SyncStatusBadge state="synced" showLabel size="medium" />
              <span className="document-browser__status-text">Connected to host</span>
            </>
          ) : isHost ? (
            <>
              <SyncStatusBadge state="synced" showLabel size="medium" />
              <span className="document-browser__status-text">Hosting</span>
            </>
          ) : (
            <>
              <SyncStatusBadge state="offline" showLabel size="medium" />
              <span className="document-browser__status-text">Disconnected</span>
            </>
          )}
          <button
            className="document-browser__refresh"
            onClick={handleRefresh}
            disabled={isLoading}
            title="Refresh document list"
            aria-label="Refresh document list"
          >
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="document-browser__error">
          <span className="document-browser__error-icon">!</span>
          {error}
        </div>
      )}

      {/* Search & Filter */}
      <div className="document-browser__toolbar">
        <input
          type="text"
          className="document-browser__search"
          placeholder="Search documents..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />

        <div className="document-browser__controls">
          <div className="document-browser__filter">
            <button
              className={`document-browser__filter-btn ${filterMode === 'all' ? 'document-browser__filter-btn--active' : ''}`}
              onClick={() => setFilterMode('all')}
            >
              All ({documentCounts.total})
            </button>
            <button
              className={`document-browser__filter-btn ${filterMode === 'local' ? 'document-browser__filter-btn--active' : ''}`}
              onClick={() => setFilterMode('local')}
            >
              Personal ({documentCounts.local})
            </button>
            {isInTeamMode && (
              <>
                <button
                  className={`document-browser__filter-btn ${filterMode === 'team' ? 'document-browser__filter-btn--active' : ''}`}
                  onClick={() => setFilterMode('team')}
                >
                  Team ({documentCounts.team})
                </button>
                {documentCounts.cached > 0 && (
                  <button
                    className={`document-browser__filter-btn ${filterMode === 'cached' ? 'document-browser__filter-btn--active' : ''}`}
                    onClick={() => setFilterMode('cached')}
                  >
                    Offline ({documentCounts.cached})
                  </button>
                )}
              </>
            )}
          </div>

          <div className="document-browser__view-controls">
            <SelectControl
              label="Sort"
              value={sort}
              onChange={(v) => setSort(v as DocumentBrowserSort)}
              options={Object.entries(SORT_LABELS).map(([value, label]) => ({ value, label }))}
            />
            <SelectControl
              label="Group"
              value={groupBy}
              onChange={(v) => setGroupBy(v as DocumentBrowserGroupBy)}
              options={[
                { value: 'none', label: 'No grouping' },
                { value: 'collection', label: 'By collection' },
              ]}
            />
            <div className="document-browser__view-toggle" role="group" aria-label="View mode">
              <button
                className={`document-browser__view-btn ${view === 'list' ? 'document-browser__view-btn--active' : ''}`}
                onClick={() => setView('list' as DocumentBrowserView)}
                title="List view"
                aria-label="List view"
                aria-pressed={view === 'list'}
              >
                <List size={16} aria-hidden="true" />
              </button>
              <button
                className={`document-browser__view-btn ${view === 'grid' ? 'document-browser__view-btn--active' : ''}`}
                onClick={() => setView('grid' as DocumentBrowserView)}
                title="Grid view"
                aria-label="Grid view"
                aria-pressed={view === 'grid'}
              >
                <LayoutGrid size={16} aria-hidden="true" />
              </button>
            </div>
            <button
              className="document-browser__new-collection-btn"
              onClick={handleCreateCollection}
              title="Create collection"
            >
              <Plus size={13} aria-hidden="true" />
              Collection
            </button>
          </div>
        </div>
      </div>

      {/* Selection bar */}
      {hasSelection && <SelectionBar model={model} />}

      {/* Document List */}
      <DocumentList model={model} compact={compact} />

      {/* PDF Export Dialog — lazy; only mounted (and its chunk fetched) when open */}
      {pdfExportOpen && (
        <Suspense fallback={null}>
          <PDFExportDialog isOpen={pdfExportOpen} onClose={() => setPdfExportOpen(false)} />
        </Suspense>
      )}

      {/* Permissions Dialog */}
      {permissionsDocId && (
        <DocumentPermissionsDialog
          documentId={permissionsDocId}
          onClose={() => setPermissionsDocId(null)}
        />
      )}
    </div>
  );
}

interface SelectControlProps {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}

function SelectControl({ label, value, options, onChange }: SelectControlProps) {
  return (
    <label className="document-browser__select">
      <span className="document-browser__select-label">{label}</span>
      <select
        className="document-browser__select-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export default DocumentBrowser;
