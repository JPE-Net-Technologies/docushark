/**
 * Backup & Restore settings tab.
 *
 * Provides UI for:
 * - Exporting a full application backup with selective categories
 * - Importing/restoring from a .diagrammer-backup archive
 * - Conflict resolution for merge-mode imports
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  BackupOptions,
  ArchiveProgress,
  ArchiveValidationResult,
  RestoreConflict,
  ConflictResolution,
  RestoreMode,
  RestoreResult,
} from '../../storage/ArchiveTypes';
import { DEFAULT_BACKUP_OPTIONS } from '../../storage/ArchiveTypes';
import {
  estimateBackupSize,
  createAndDownloadBackup,
  getLastBackupTimestamp,
} from '../../storage/BackupExportService';
import { validateBackup, restoreBackup } from '../../storage/BackupImportService';
import './BackupSettings.css';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const size = sizes[i] ?? 'GB';
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${size}`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BackupSettings() {
  // ── Export state ─────────────────────────────────────────────────────
  const [options, setOptions] = useState<BackupOptions>({ ...DEFAULT_BACKUP_OPTIONS });
  const [estimatedSize, setEstimatedSize] = useState<number | null>(null);
  const [isEstimating, setIsEstimating] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ArchiveProgress | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [lastBackup, setLastBackup] = useState<number | null>(getLastBackupTimestamp());

  // ── Import state ────────────────────────────────────────────────────
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [validation, setValidation] = useState<ArchiveValidationResult | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [restoreMode, setRestoreMode] = useState<RestoreMode>('merge');
  const [conflictResolutions, setConflictResolutions] = useState<Record<string, ConflictResolution>>({});
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<ArchiveProgress | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Estimate size on option change ──────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setIsEstimating(true);
    estimateBackupSize(options)
      .then((est) => {
        if (!cancelled) {
          setEstimatedSize(est.uncompressedBytes);
          setIsEstimating(false);
        }
      })
      .catch(() => {
        if (!cancelled) setIsEstimating(false);
      });
    return () => { cancelled = true; };
  }, [options]);

  // ── Option toggles ─────────────────────────────────────────────────
  const toggleOption = useCallback((key: keyof BackupOptions) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const selectAll = useCallback(() => {
    setOptions({ ...DEFAULT_BACKUP_OPTIONS });
  }, []);

  const deselectAll = useCallback(() => {
    setOptions({
      includeDocuments: false,
      includeBlobs: false,
      includeSettings: false,
      includeStyleProfiles: false,
      includeColorPalette: false,
      includeShapeLibraries: false,
      includeIconLibrary: false,
      includeUiPreferences: false,
      includeIconPresets: false,
    });
  }, []);

  const hasAnySelected = Object.values(options).some(Boolean);

  // ── Export handler ──────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    setIsExporting(true);
    setExportError(null);
    setExportProgress(null);

    try {
      await createAndDownloadBackup(options, (progress) => {
        setExportProgress(progress);
      });
      setLastBackup(getLastBackupTimestamp());
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setIsExporting(false);
    }
  }, [options]);

  // ── File selection ──────────────────────────────────────────────────
  const handleFileSelect = useCallback(async (file: File) => {
    setSelectedFile(file);
    setValidation(null);
    setRestoreResult(null);
    setRestoreError(null);
    setConflictResolutions({});
    setIsValidating(true);

    try {
      const result = await validateBackup(file);
      setValidation(result);

      // Set default conflict resolutions
      const defaults: Record<string, ConflictResolution> = {};
      for (const conflict of result.conflicts) {
        defaults[conflict.id] = 'keep-existing';
      }
      setConflictResolutions(defaults);
    } catch (err) {
      setValidation({
        valid: false,
        manifest: null,
        errors: [err instanceof Error ? err.message : 'Validation failed'],
        warnings: [],
        conflicts: [],
      });
    } finally {
      setIsValidating(false);
    }
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  }, [handleFileSelect]);

  // ── Drag and drop ───────────────────────────────────────────────────
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragActive(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragActive(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      handleFileSelect(file);
    }
  }, [handleFileSelect]);

  // ── Conflict resolution ─────────────────────────────────────────────
  const setResolution = useCallback((conflictId: string, resolution: ConflictResolution) => {
    setConflictResolutions((prev) => ({ ...prev, [conflictId]: resolution }));
  }, []);

  // ── Restore handler ─────────────────────────────────────────────────
  const handleRestore = useCallback(async () => {
    if (!selectedFile || !validation?.valid) return;

    setIsRestoring(true);
    setRestoreError(null);
    setRestoreResult(null);
    setRestoreProgress(null);

    try {
      const result = await restoreBackup(
        selectedFile,
        { mode: restoreMode, conflictResolutions },
        (progress) => {
          setRestoreProgress(progress);
        }
      );
      setRestoreResult(result);
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      setIsRestoring(false);
    }
  }, [selectedFile, validation, restoreMode, conflictResolutions]);

  // ── Render ──────────────────────────────────────────────────────────
  const optionItems: Array<{ key: keyof BackupOptions; label: string; detail?: string }> = [
    { key: 'includeDocuments', label: 'Documents', detail: 'All local diagrams' },
    { key: 'includeBlobs', label: 'Images & Files', detail: 'Embedded images, icons, attachments' },
    { key: 'includeSettings', label: 'Settings', detail: 'App preferences' },
    { key: 'includeStyleProfiles', label: 'Style Profiles' },
    { key: 'includeColorPalette', label: 'Color Palette', detail: 'Recent colors' },
    { key: 'includeShapeLibraries', label: 'Shape Libraries', detail: 'Custom shape collections' },
    { key: 'includeIconLibrary', label: 'Icon Library', detail: 'Custom uploaded icons' },
    { key: 'includeUiPreferences', label: 'UI Preferences', detail: 'Panel layout, expanded sections' },
    { key: 'includeIconPresets', label: 'Icon Presets', detail: 'Custom icon display presets' },
  ];

  return (
    <div className="backup-settings">
      {/* ── Export Section ──────────────────────────────────────────── */}
      <div className="backup-section">
        <h3 className="backup-section-title">Export Backup</h3>
        <p className="backup-section-description">
          Export your application data as a portable archive. Choose which data to include.
        </p>

        <div className="backup-select-actions">
          <button className="backup-link-btn" onClick={selectAll}>Select All</button>
          <button className="backup-link-btn" onClick={deselectAll}>Deselect All</button>
        </div>

        <div className="backup-options">
          {optionItems.map(({ key, label, detail }) => (
            <label key={key} className="backup-option-row">
              <input
                type="checkbox"
                checked={options[key]}
                onChange={() => toggleOption(key)}
                disabled={isExporting}
              />
              <span className="backup-option-label">
                {label}
                {detail && <span className="option-detail">— {detail}</span>}
              </span>
            </label>
          ))}
        </div>

        <div className="backup-size-info">
          <span>Estimated size:</span>
          <span className="backup-size-value">
            {isEstimating ? 'Calculating...' : estimatedSize !== null ? `~${formatBytes(estimatedSize)}` : '—'}
          </span>
          <span>(uncompressed; archive will be smaller)</span>
        </div>

        {lastBackup && (
          <div className="backup-last-info">
            Last backup: {formatTimestamp(lastBackup)}
          </div>
        )}

        <div className="backup-actions">
          <button
            className="backup-btn backup-btn-primary"
            onClick={handleExport}
            disabled={isExporting || !hasAnySelected}
          >
            {isExporting ? 'Exporting...' : 'Export Backup'}
          </button>
        </div>

        {isExporting && exportProgress && (
          <div className="backup-progress-container">
            <div className="backup-progress-bar-track">
              <div
                className="backup-progress-bar-fill"
                style={{ width: `${exportProgress.total > 0 ? (exportProgress.current / exportProgress.total) * 100 : 0}%` }}
              />
            </div>
            <div className="backup-progress-detail">
              {exportProgress.detail ?? exportProgress.phase}
            </div>
          </div>
        )}

        {exportError && (
          <div className="backup-result backup-result-error">{exportError}</div>
        )}
      </div>

      {/* ── Import Section ──────────────────────────────────────────── */}
      <div className="backup-section">
        <h3 className="backup-section-title">Restore from Backup</h3>
        <p className="backup-section-description">
          Import a previously exported backup archive to restore your data.
        </p>

        {/* File drop zone */}
        <div
          className={`backup-dropzone ${isDragActive ? 'drag-active' : ''}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <p className="backup-dropzone-label">
            {selectedFile
              ? <>Selected: <strong>{selectedFile.name}</strong> ({formatBytes(selectedFile.size)})</>
              : <>Drop a <strong>.diagrammer-backup</strong> file here, or click to browse</>
            }
          </p>
          <p className="backup-dropzone-hint">.diagrammer-backup files only</p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".diagrammer-backup,.zip"
          style={{ display: 'none' }}
          onChange={handleFileInput}
        />

        {/* Validation loading */}
        {isValidating && (
          <div className="backup-validation">
            <p className="backup-validation-title">Validating archive...</p>
          </div>
        )}

        {/* Validation summary */}
        {validation && !isValidating && (
          <div className="backup-validation">
            <p className="backup-validation-title">
              {validation.valid ? '✅ Archive is valid' : '❌ Archive is invalid'}
            </p>
            {validation.manifest && (
              <>
                <div className="backup-validation-item">
                  📄 {validation.manifest.contents.documentCount} document(s)
                </div>
                <div className="backup-validation-item">
                  🖼️ {validation.manifest.contents.blobCount} blob(s) ({formatBytes(validation.manifest.contents.blobTotalSize)})
                </div>
                <div className="backup-validation-item">
                  🎨 {validation.manifest.contents.styleProfileCount} style profile(s)
                </div>
                <div className="backup-validation-item">
                  📚 {validation.manifest.contents.shapeLibraryCount} shape library(ies),{' '}
                  {validation.manifest.contents.shapeLibraryItemCount} item(s)
                </div>
                {validation.manifest.contents.hasSettings && (
                  <div className="backup-validation-item">⚙️ Settings included</div>
                )}
                {validation.manifest.contents.hasColorPalette && (
                  <div className="backup-validation-item">🎨 Color palette included</div>
                )}
                {validation.manifest.contents.hasIconLibrary && (
                  <div className="backup-validation-item">📦 Icon library included</div>
                )}
                <div className="backup-validation-item" style={{ marginTop: 4, fontSize: 11, opacity: 0.7 }}>
                  Created: {formatTimestamp(validation.manifest.createdAt)} · App v{validation.manifest.appVersion}
                </div>
              </>
            )}
            {validation.errors.map((err, i) => (
              <p key={i} className="backup-validation-error">⚠ {err}</p>
            ))}
            {validation.warnings.map((warn, i) => (
              <p key={i} className="backup-validation-warning">⚠ {warn}</p>
            ))}
          </div>
        )}

        {/* Restore mode toggle */}
        {validation?.valid && (
          <>
            <div className="backup-mode-toggle">
              <button
                className={`backup-mode-option ${restoreMode === 'merge' ? 'active' : ''}`}
                onClick={() => setRestoreMode('merge')}
              >
                Merge
                <div className="backup-mode-description">Add to existing data</div>
              </button>
              <button
                className={`backup-mode-option ${restoreMode === 'replace' ? 'active' : ''}`}
                onClick={() => setRestoreMode('replace')}
              >
                Replace
                <div className="backup-mode-description">Wipe &amp; restore</div>
              </button>
            </div>

            {/* Conflicts */}
            {restoreMode === 'merge' && validation.conflicts.length > 0 && (
              <div className="backup-conflicts">
                <p className="backup-conflicts-title">
                  ⚠️ {validation.conflicts.length} conflict(s) detected
                </p>
                {validation.conflicts.map((conflict) => (
                  <ConflictRow
                    key={conflict.id}
                    conflict={conflict}
                    resolution={conflictResolutions[conflict.id] ?? 'keep-existing'}
                    onResolve={(res) => setResolution(conflict.id, res)}
                  />
                ))}
              </div>
            )}

            {/* Restore button */}
            <div className="backup-actions">
              <button
                className={`backup-btn ${restoreMode === 'replace' ? 'backup-btn-danger' : 'backup-btn-primary'}`}
                onClick={handleRestore}
                disabled={isRestoring}
              >
                {isRestoring
                  ? 'Restoring...'
                  : restoreMode === 'replace'
                    ? 'Replace All & Restore'
                    : 'Merge & Restore'
                }
              </button>
            </div>

            {/* Restore progress */}
            {isRestoring && restoreProgress && (
              <div className="backup-progress-container">
                <div className="backup-progress-bar-track">
                  <div
                    className="backup-progress-bar-fill"
                    style={{ width: `${restoreProgress.total > 0 ? (restoreProgress.current / restoreProgress.total) * 100 : 0}%` }}
                  />
                </div>
                <div className="backup-progress-detail">
                  {restoreProgress.detail ?? restoreProgress.phase}
                </div>
              </div>
            )}
          </>
        )}

        {/* Restore result */}
        {restoreResult && (
          <div className={`backup-result ${restoreResult.success ? 'backup-result-success' : 'backup-result-error'}`}>
            {restoreResult.success ? (
              <>
                ✅ Restore completed in {(restoreResult.durationMs / 1000).toFixed(1)}s —{' '}
                {restoreResult.restored.documents} document(s),{' '}
                {restoreResult.restored.blobs} blob(s),{' '}
                {restoreResult.restored.styleProfiles} profile(s)
                {restoreResult.warnings.length > 0 && (
                  <div style={{ marginTop: 4, fontSize: 12 }}>
                    ⚠ {restoreResult.warnings.length} warning(s)
                  </div>
                )}
              </>
            ) : (
              <>❌ Restore failed</>
            )}
          </div>
        )}

        {restoreError && (
          <div className="backup-result backup-result-error">{restoreError}</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conflict resolution row
// ---------------------------------------------------------------------------

function ConflictRow({
  conflict,
  resolution,
  onResolve,
}: {
  conflict: RestoreConflict;
  resolution: ConflictResolution;
  onResolve: (r: ConflictResolution) => void;
}) {
  return (
    <div className="backup-conflict-item">
      <div>
        <div className="backup-conflict-info">
          <strong>{conflict.incomingName}</strong>
          {conflict.existingName !== conflict.incomingName && (
            <> (existing: {conflict.existingName})</>
          )}
        </div>
        <div className="backup-conflict-type">{conflict.type}</div>
      </div>
      <select
        className="backup-conflict-select"
        value={resolution}
        onChange={(e) => onResolve(e.target.value as ConflictResolution)}
      >
        <option value="keep-existing">Keep Existing</option>
        <option value="replace">Replace</option>
        <option value="keep-both">Keep Both</option>
      </select>
    </div>
  );
}
