/**
 * Full application backup export service.
 *
 * Collects data from all application stores and blob storage, then packages
 * it into a ZIP archive with a manifest for integrity verification.
 *
 * Uses ArchiveUtils for ZIP creation and checksum computation.
 */

import { blobStorage } from './BlobStorage';
import {
  createArchiveZip,
  collectBlobsForDocuments,
  computeChecksum,
  encodeJSON,
  buildContents,
  getAppVersion,
  triggerDownload,
} from './ArchiveUtils';
import type { ArchiveEntry, ArchiveManifest } from './ArchiveTypes';
import type {
  BackupOptions,
  BackupSizeEstimate,
  ArchiveProgressCallback,
} from './ArchiveTypes';
import { DEFAULT_BACKUP_OPTIONS } from './ArchiveTypes';
import { usePersistenceStore, loadDocumentFromStorage } from '../store/persistenceStore';
import { useSettingsStore } from '../store/settingsStore';
import { useStyleProfileStore } from '../store/styleProfileStore';
import { useColorPaletteStore } from '../store/colorPaletteStore';
import { useIconLibraryStore } from '../store/iconLibraryStore';
import { useIconPresetStore } from '../store/iconPresetStore';
import { useCustomShapeLibraryStore } from '../store/customShapeLibraryStore';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';

/** localStorage key for tracking last backup timestamp. */
const LAST_BACKUP_KEY = 'diagrammer-last-backup';

// ---------------------------------------------------------------------------
// Size Estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the uncompressed backup size before exporting.
 */
export async function estimateBackupSize(
  options: BackupOptions = DEFAULT_BACKUP_OPTIONS
): Promise<BackupSizeEstimate> {
  const breakdown: BackupSizeEstimate['breakdown'] = {
    documents: 0,
    blobs: 0,
    settings: 0,
    styleProfiles: 0,
    colorPalette: 0,
    shapeLibraries: 0,
    iconLibrary: 0,
    uiPreferences: 0,
    iconPresets: 0,
  };

  if (options.includeDocuments) {
    const docMetas = usePersistenceStore.getState().getDocumentList();
    for (const meta of docMetas) {
      const doc = loadDocumentFromStorage(meta.id);
      if (doc) {
        breakdown.documents += new Blob([JSON.stringify(doc)]).size;
      }
    }
  }

  if (options.includeBlobs) {
    const stats = await blobStorage.getStorageStats();
    breakdown.blobs = stats.used;
  }

  if (options.includeSettings) {
    const { defaultConnectorType, defaultStyleProfileId, showStaticProperties,
      hideDefaultStyleProfiles, saveIconStyleToProfile, saveLabelStyleToProfile,
      showMinimap, layerClickFocusShape, gridOpacity, animationDuration,
    } = useSettingsStore.getState();
    breakdown.settings = new Blob([JSON.stringify({
      defaultConnectorType, defaultStyleProfileId, showStaticProperties,
      hideDefaultStyleProfiles, saveIconStyleToProfile, saveLabelStyleToProfile,
      showMinimap, layerClickFocusShape, gridOpacity, animationDuration,
    })]).size;
  }

  if (options.includeStyleProfiles) {
    const { profiles } = useStyleProfileStore.getState();
    breakdown.styleProfiles = new Blob([JSON.stringify(profiles)]).size;
  }

  if (options.includeColorPalette) {
    const { recentColors, customColor } = useColorPaletteStore.getState();
    breakdown.colorPalette = new Blob([JSON.stringify({ recentColors, customColor })]).size;
  }

  if (options.includeShapeLibraries) {
    const { libraries } = useCustomShapeLibraryStore.getState();
    breakdown.shapeLibraries = new Blob([JSON.stringify(libraries)]).size;
    const items = await blobStorage.listAllShapeItems();
    for (const item of items) {
      breakdown.shapeLibraries += new Blob([JSON.stringify(item)]).size;
    }
  }

  if (options.includeIconLibrary) {
    const { customIcons } = useIconLibraryStore.getState();
    breakdown.iconLibrary = new Blob([JSON.stringify(customIcons)]).size;
  }

  if (options.includeUiPreferences) {
    const { expandedSections, propertyPanelWidth } = useUIPreferencesStore.getState();
    breakdown.uiPreferences = new Blob([JSON.stringify({ expandedSections, propertyPanelWidth })]).size;
  }

  if (options.includeIconPresets) {
    const { customPresets } = useIconPresetStore.getState();
    breakdown.iconPresets = new Blob([JSON.stringify(customPresets)]).size;
  }

  const uncompressedBytes = Object.values(breakdown).reduce((sum, v) => sum + v, 0);

  return { uncompressedBytes, breakdown };
}

// ---------------------------------------------------------------------------
// Backup Creation
// ---------------------------------------------------------------------------

/**
 * Create a full application backup archive.
 *
 * @returns A Blob containing the ZIP archive.
 */
export async function createBackup(
  options: BackupOptions = DEFAULT_BACKUP_OPTIONS,
  onProgress?: ArchiveProgressCallback
): Promise<Blob> {
  const entries: ArchiveEntry[] = [];
  const checksums: Record<string, string> = {};
  const progress = onProgress ?? (() => {});

  // Track stats for the manifest
  let blobCount = 0;
  let blobTotalSize = 0;
  let styleProfileCount = 0;
  let shapeLibraryCount = 0;
  let shapeLibraryItemCount = 0;

  // ── Documents ───────────────────────────────────────────────────────
  const docMetas = usePersistenceStore.getState().getDocumentList();
  const documentIds: string[] = [];

  if (options.includeDocuments) {
    progress({ phase: 'collecting', current: 0, total: docMetas.length, detail: 'Collecting documents' });

    for (let i = 0; i < docMetas.length; i++) {
      const meta = docMetas[i]!;
      const doc = loadDocumentFromStorage(meta.id);
      if (!doc) continue;

      documentIds.push(meta.id);
      const path = `documents/${meta.id}.json`;
      const data = encodeJSON(doc);
      entries.push({ path, data });
      checksums[path] = await computeChecksum(data);

      progress({ phase: 'collecting', current: i + 1, total: docMetas.length, detail: `Document: ${doc.name}` });
    }
  }

  // ── Blobs ───────────────────────────────────────────────────────────
  if (options.includeBlobs) {
    // Collect all blobs — either scoped to included documents, or all blobs
    let blobIds: Set<string>;
    if (options.includeDocuments && documentIds.length > 0) {
      blobIds = collectBlobsForDocuments(documentIds);
      // Also include icon blobs
      const iconBlobs = useIconLibraryStore.getState().customIcons
        .filter((icon) => icon.blobId)
        .map((icon) => icon.blobId!);
      for (const id of iconBlobs) {
        blobIds.add(id);
      }
    } else {
      // Export all blobs if not scoping to documents
      const allBlobs = await blobStorage.listAllBlobs();
      blobIds = new Set(allBlobs.map((b) => b.id));
    }

    const blobIdArray = Array.from(blobIds);
    progress({ phase: 'collecting', current: 0, total: blobIdArray.length, detail: 'Collecting blobs' });

    for (let i = 0; i < blobIdArray.length; i++) {
      const blobId = blobIdArray[i]!;
      const blob = await blobStorage.loadBlob(blobId);
      if (!blob) continue;

      const arrayBuffer = await blob.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      const path = `blobs/${blobId}.bin`;
      entries.push({ path, data });
      checksums[path] = await computeChecksum(data);

      blobCount++;
      blobTotalSize += data.byteLength;

      progress({ phase: 'collecting', current: i + 1, total: blobIdArray.length, detail: `Blob ${i + 1}/${blobIdArray.length}` });
    }
  }

  // ── Shape library items (IndexedDB) ─────────────────────────────────
  if (options.includeShapeLibraries) {
    const { libraries } = useCustomShapeLibraryStore.getState();
    shapeLibraryCount = libraries.length;

    const librariesData = encodeJSON(libraries);
    const librariesPath = 'custom-shape-libraries.json';
    entries.push({ path: librariesPath, data: librariesData });
    checksums[librariesPath] = await computeChecksum(librariesData);

    const allItems = await blobStorage.listAllShapeItems();
    shapeLibraryItemCount = allItems.length;

    for (const item of allItems) {
      const path = `shape-library-items/${item.id}.json`;
      const data = encodeJSON(item);
      entries.push({ path, data });
      checksums[path] = await computeChecksum(data);
    }
  }

  // ── Settings ────────────────────────────────────────────────────────
  if (options.includeSettings) {
    const { defaultConnectorType, defaultStyleProfileId, showStaticProperties,
      hideDefaultStyleProfiles, saveIconStyleToProfile, saveLabelStyleToProfile,
      showMinimap, layerClickFocusShape, gridOpacity, animationDuration,
    } = useSettingsStore.getState();
    const settingsData = encodeJSON({
      defaultConnectorType, defaultStyleProfileId, showStaticProperties,
      hideDefaultStyleProfiles, saveIconStyleToProfile, saveLabelStyleToProfile,
      showMinimap, layerClickFocusShape, gridOpacity, animationDuration,
    });
    const settingsPath = 'settings.json';
    entries.push({ path: settingsPath, data: settingsData });
    checksums[settingsPath] = await computeChecksum(settingsData);
  }

  // ── Style profiles ──────────────────────────────────────────────────
  if (options.includeStyleProfiles) {
    const { profiles } = useStyleProfileStore.getState();
    styleProfileCount = profiles.length;
    const data = encodeJSON(profiles);
    const path = 'style-profiles.json';
    entries.push({ path, data });
    checksums[path] = await computeChecksum(data);
  }

  // ── Color palette ───────────────────────────────────────────────────
  if (options.includeColorPalette) {
    const { recentColors, customColor } = useColorPaletteStore.getState();
    const data = encodeJSON({ recentColors, customColor });
    const path = 'color-palette.json';
    entries.push({ path, data });
    checksums[path] = await computeChecksum(data);
  }

  // ── Icon library ────────────────────────────────────────────────────
  if (options.includeIconLibrary) {
    const { customIcons } = useIconLibraryStore.getState();
    const data = encodeJSON(customIcons);
    const path = 'icon-library.json';
    entries.push({ path, data });
    checksums[path] = await computeChecksum(data);
  }

  // ── UI preferences ──────────────────────────────────────────────────
  if (options.includeUiPreferences) {
    const { expandedSections, propertyPanelWidth } = useUIPreferencesStore.getState();
    const data = encodeJSON({ expandedSections, propertyPanelWidth });
    const path = 'ui-preferences.json';
    entries.push({ path, data });
    checksums[path] = await computeChecksum(data);
  }

  // ── Icon presets ────────────────────────────────────────────────────
  if (options.includeIconPresets) {
    const { customPresets } = useIconPresetStore.getState();
    const data = encodeJSON(customPresets);
    const path = 'icon-presets.json';
    entries.push({ path, data });
    checksums[path] = await computeChecksum(data);
  }

  // ── Manifest ────────────────────────────────────────────────────────
  const manifest: ArchiveManifest = {
    version: 1,
    type: 'diagrammer-backup',
    createdAt: Date.now(),
    appVersion: getAppVersion(),
    contents: buildContents({
      documentIds,
      blobCount,
      blobTotalSize,
      shapeLibraryCount,
      shapeLibraryItemCount,
      styleProfileCount,
      hasSettings: options.includeSettings,
      hasColorPalette: options.includeColorPalette,
      hasIconLibrary: options.includeIconLibrary,
      hasUiPreferences: options.includeUiPreferences,
      hasIconPresets: options.includeIconPresets,
    }),
    checksums,
  };

  const manifestData = encodeJSON(manifest);
  entries.push({ path: 'manifest.json', data: manifestData });

  // ── Compress ────────────────────────────────────────────────────────
  progress({ phase: 'compressing', current: 0, total: 1, detail: 'Creating archive' });
  const zipData = createArchiveZip(entries);
  progress({ phase: 'done', current: 1, total: 1 });

  // Record last backup timestamp
  localStorage.setItem(LAST_BACKUP_KEY, String(Date.now()));

  return new Blob([zipData as unknown as BlobPart], { type: 'application/zip' });
}

// ---------------------------------------------------------------------------
// Convenience: create and download
// ---------------------------------------------------------------------------

/**
 * Create a full backup and trigger a browser download.
 */
export async function createAndDownloadBackup(
  options: BackupOptions = DEFAULT_BACKUP_OPTIONS,
  onProgress?: ArchiveProgressCallback
): Promise<void> {
  const blob = await createBackup(options, onProgress);
  const timestamp = new Date().toISOString().slice(0, 10);
  triggerDownload(blob, `diagrammer-backup-${timestamp}.diagrammer-backup`);
}

// ---------------------------------------------------------------------------
// Last backup info
// ---------------------------------------------------------------------------

/** Get the timestamp of the last successful backup (or null). */
export function getLastBackupTimestamp(): number | null {
  const raw = localStorage.getItem(LAST_BACKUP_KEY);
  if (!raw) return null;
  const ts = Number(raw);
  return Number.isFinite(ts) ? ts : null;
}
