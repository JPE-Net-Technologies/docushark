/**
 * Full application backup import/restore service.
 *
 * Validates and restores a `.diagrammer-backup` archive, supporting
 * both "merge" (add to existing data) and "replace" (wipe and restore) modes.
 *
 * Uses ArchiveUtils for ZIP extraction and integrity validation.
 */

import { blobStorage } from './BlobStorage';
import {
  readArchiveZip,
  readFileAsUint8Array,
  validateChecksums,
  validateManifest,
  decodeJSON,
} from './ArchiveUtils';
import type { ArchiveEntry } from './ArchiveTypes';
import type {
  ArchiveManifest,
  ArchiveValidationResult,
  RestoreConflict,
  RestoreOptions,
  RestoreResult,
  ArchiveProgressCallback,
} from './ArchiveTypes';
import type { DiagramDocument } from '../types/Document';
import { getDocumentMetadata } from '../types/Document';
import {
  usePersistenceStore,
  saveDocumentToStorage,
  loadDocumentFromStorage,
  deleteDocumentFromStorage,
} from '../store/persistenceStore';
import { useSettingsStore } from '../store/settingsStore';
import { useStyleProfileStore } from '../store/styleProfileStore';
import { useColorPaletteStore } from '../store/colorPaletteStore';
import { useIconLibraryStore } from '../store/iconLibraryStore';
import { useIconPresetStore } from '../store/iconPresetStore';
import { useCustomShapeLibraryStore } from '../store/customShapeLibraryStore';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';
import { useDocumentRegistry } from '../store/documentRegistry';
import type { CustomShapeLibrary } from '../storage/ShapeLibraryTypes';
import type { StyleProfile } from '../store/styleProfileStore';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a backup file without restoring it.
 * Returns a summary of the archive contents and any conflicts with existing data.
 */
export async function validateBackup(file: File): Promise<ArchiveValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const conflicts: RestoreConflict[] = [];

  let manifest: ArchiveManifest | null = null;
  let entries: ArchiveEntry[];

  // Read and parse ZIP
  try {
    const zipData = await readFileAsUint8Array(file);
    entries = readArchiveZip(zipData);
  } catch (err) {
    return {
      valid: false,
      manifest: null,
      errors: [`Failed to read archive: ${err instanceof Error ? err.message : String(err)}`],
      warnings: [],
      conflicts: [],
    };
  }

  // Find and validate manifest
  const manifestEntry = entries.find((e) => e.path === 'manifest.json');
  if (!manifestEntry) {
    return {
      valid: false,
      manifest: null,
      errors: ['Archive is missing manifest.json'],
      warnings: [],
      conflicts: [],
    };
  }

  try {
    const raw = decodeJSON(manifestEntry.data);
    manifest = validateManifest(raw);
  } catch (err) {
    return {
      valid: false,
      manifest: null,
      errors: [`Invalid manifest: ${err instanceof Error ? err.message : String(err)}`],
      warnings: [],
      conflicts: [],
    };
  }

  if (manifest.type !== 'diagrammer-backup') {
    errors.push(`Unexpected archive type: ${manifest.type}. Expected diagrammer-backup.`);
  }

  // Verify checksums
  const mismatches = await validateChecksums(entries, manifest.checksums);
  if (mismatches.length > 0) {
    errors.push(`Checksum mismatch for: ${mismatches.join(', ')}`);
  }

  // Detect document conflicts
  const existingDocs = usePersistenceStore.getState().documents;
  for (const docId of manifest.contents.documentIds) {
    const existing = existingDocs[docId];
    if (existing) {
      const docEntry = entries.find((e) => e.path === `documents/${docId}.json`);
      let incomingModifiedAt = 0;
      let incomingName = docId;
      if (docEntry) {
        try {
          const doc = decodeJSON<DiagramDocument>(docEntry.data);
          incomingModifiedAt = doc.modifiedAt;
          incomingName = doc.name;
        } catch {
          // Use defaults
        }
      }

      conflicts.push({
        id: `doc:${docId}`,
        type: 'document',
        existingName: existing.name,
        incomingName,
        existingModifiedAt: existing.modifiedAt,
        incomingModifiedAt,
      });
    }
  }

  // Detect style profile conflicts
  const profilesEntry = entries.find((e) => e.path === 'style-profiles.json');
  if (profilesEntry) {
    try {
      const incomingProfiles = decodeJSON<StyleProfile[]>(profilesEntry.data);
      const existingProfiles = useStyleProfileStore.getState().profiles;
      const existingById = new Map(existingProfiles.map((p) => [p.id, p]));

      for (const incoming of incomingProfiles) {
        const existing = existingById.get(incoming.id);
        if (existing) {
          conflicts.push({
            id: `profile:${incoming.id}`,
            type: 'style-profile',
            existingName: existing.name,
            incomingName: incoming.name,
            existingModifiedAt: existing.createdAt,
            incomingModifiedAt: incoming.createdAt,
          });
        }
      }
    } catch {
      warnings.push('Could not parse style profiles for conflict detection');
    }
  }

  // Detect shape library conflicts
  const librariesEntry = entries.find((e) => e.path === 'custom-shape-libraries.json');
  if (librariesEntry) {
    try {
      const incomingLibs = decodeJSON<CustomShapeLibrary[]>(librariesEntry.data);
      const existingLibs = useCustomShapeLibraryStore.getState().libraries;
      const existingById = new Map(existingLibs.map((l) => [l.id, l]));

      for (const incoming of incomingLibs) {
        const existing = existingById.get(incoming.id);
        if (existing) {
          conflicts.push({
            id: `library:${incoming.id}`,
            type: 'shape-library',
            existingName: existing.name,
            incomingName: incoming.name,
            existingModifiedAt: existing.modifiedAt,
            incomingModifiedAt: incoming.modifiedAt,
          });
        }
      }
    } catch {
      warnings.push('Could not parse shape libraries for conflict detection');
    }
  }

  return {
    valid: errors.length === 0,
    manifest,
    errors,
    warnings,
    conflicts,
  };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Restore a full backup archive.
 *
 * Restore order: blobs → shape library items → documents → settings/profiles/etc.
 * This ensures references are valid before the documents that use them are loaded.
 */
export async function restoreBackup(
  file: File,
  options: RestoreOptions,
  onProgress?: ArchiveProgressCallback
): Promise<RestoreResult> {
  const startTime = Date.now();
  const progress = onProgress ?? (() => {});
  const warnings: string[] = [];
  const restored: RestoreResult['restored'] = {
    documents: 0,
    blobs: 0,
    settings: false,
    styleProfiles: 0,
    colorPalette: false,
    shapeLibraries: 0,
    shapeLibraryItems: 0,
    iconLibrary: false,
    uiPreferences: false,
    iconPresets: false,
  };

  // ── Read archive ────────────────────────────────────────────────────
  progress({ phase: 'reading', current: 0, total: 1, detail: 'Reading archive' });

  let entries: ArchiveEntry[];
  let manifest: ArchiveManifest;

  try {
    const zipData = await readFileAsUint8Array(file);
    entries = readArchiveZip(zipData);
  } catch (err) {
    return {
      success: false,
      restored,
      warnings: [`Failed to read archive: ${err instanceof Error ? err.message : String(err)}`],
      durationMs: Date.now() - startTime,
    };
  }

  const manifestEntry = entries.find((e) => e.path === 'manifest.json');
  if (!manifestEntry) {
    return {
      success: false,
      restored,
      warnings: ['Archive is missing manifest.json'],
      durationMs: Date.now() - startTime,
    };
  }

  try {
    manifest = validateManifest(decodeJSON(manifestEntry.data));
  } catch (err) {
    return {
      success: false,
      restored,
      warnings: [`Invalid manifest: ${err instanceof Error ? err.message : String(err)}`],
      durationMs: Date.now() - startTime,
    };
  }

  // ── Validate checksums ──────────────────────────────────────────────
  progress({ phase: 'validating', current: 0, total: 1, detail: 'Verifying integrity' });

  const mismatches = await validateChecksums(entries, manifest.checksums);
  if (mismatches.length > 0) {
    return {
      success: false,
      restored,
      warnings: [`Checksum verification failed for: ${mismatches.join(', ')}`],
      durationMs: Date.now() - startTime,
    };
  }

  const shouldRestore = (category: string) => {
    if (!options.categories) return true;
    const key = category as keyof NonNullable<RestoreOptions['categories']>;
    return options.categories[key] !== false;
  };

  // ── Replace mode: wipe existing data ────────────────────────────────
  if (options.mode === 'replace') {
    await wipeExistingData(shouldRestore);
  }

  // Index entries by path for quick lookup
  const entryMap = new Map(entries.map((e) => [e.path, e]));

  // ── Restore blobs ───────────────────────────────────────────────────
  if (shouldRestore('includeBlobs')) {
    const blobEntries = entries.filter((e) => e.path.startsWith('blobs/'));
    progress({ phase: 'restoring-blobs', current: 0, total: blobEntries.length, detail: 'Restoring blobs' });

    for (let i = 0; i < blobEntries.length; i++) {
      const entry = blobEntries[i]!;
      const blobId = entry.path.replace('blobs/', '').replace('.bin', '');

      try {
        // Check if blob already exists (content-addressed deduplication)
        const existingMeta = await blobStorage.getBlobMetadata(blobId);
        if (!existingMeta) {
          const blob = new Blob([entry.data.buffer as ArrayBuffer]);
          await blobStorage.saveBlob(blob, blobId);
        }
        restored.blobs++;
      } catch (err) {
        warnings.push(`Failed to restore blob ${blobId}: ${err instanceof Error ? err.message : String(err)}`);
      }

      progress({ phase: 'restoring-blobs', current: i + 1, total: blobEntries.length, detail: `Blob ${i + 1}/${blobEntries.length}` });
    }
  }

  // ── Restore shape library items ─────────────────────────────────────
  if (shouldRestore('includeShapeLibraries')) {
    const itemEntries = entries.filter((e) => e.path.startsWith('shape-library-items/'));

    for (const entry of itemEntries) {
      try {
        const item = decodeJSON(entry.data);
        await blobStorage.saveShapeItem(item as Parameters<typeof blobStorage.saveShapeItem>[0]);
        restored.shapeLibraryItems++;
      } catch (err) {
        warnings.push(`Failed to restore shape library item: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Restore documents ───────────────────────────────────────────────
  if (shouldRestore('includeDocuments')) {
    const docEntries = entries.filter((e) => e.path.startsWith('documents/') && e.path.endsWith('.json'));
    progress({ phase: 'restoring-documents', current: 0, total: docEntries.length, detail: 'Restoring documents' });

    for (let i = 0; i < docEntries.length; i++) {
      const entry = docEntries[i]!;

      try {
        const doc = decodeJSON<DiagramDocument>(entry.data);
        const conflictId = `doc:${doc.id}`;
        const resolution = options.conflictResolutions[conflictId];

        if (options.mode === 'merge' && loadDocumentFromStorage(doc.id)) {
          // Conflict exists in merge mode
          if (resolution === 'keep-existing') {
            // Skip this document
            continue;
          } else if (resolution === 'keep-both') {
            // Import with a new ID (suffix name)
            const { nanoid } = await import('nanoid');
            doc.id = nanoid();
            doc.name = `${doc.name} (restored)`;
          }
          // 'replace' or default: overwrite
        }

        saveDocumentToStorage(doc);

        // Update persistence store's document index
        const metadata = getDocumentMetadata(doc);
        usePersistenceStore.setState((state) => ({
          documents: {
            ...state.documents,
            [doc.id]: metadata,
          },
        }));

        // Register in document registry
        useDocumentRegistry.getState().registerLocal(metadata);

        // Increment blob usage counts
        if (doc.blobReferences) {
          for (const blobId of doc.blobReferences) {
            await blobStorage.incrementUsageCount(blobId).catch(() => {
              // Non-fatal
            });
          }
        }

        restored.documents++;
      } catch (err) {
        warnings.push(`Failed to restore document: ${err instanceof Error ? err.message : String(err)}`);
      }

      progress({ phase: 'restoring-documents', current: i + 1, total: docEntries.length, detail: `Document ${i + 1}/${docEntries.length}` });
    }
  }

  // ── Restore settings ────────────────────────────────────────────────
  progress({ phase: 'restoring-settings', current: 0, total: 1, detail: 'Restoring settings' });

  if (shouldRestore('includeSettings')) {
    const settingsEntry = entryMap.get('settings.json');
    if (settingsEntry) {
      try {
        const settings = decodeJSON<Record<string, unknown>>(settingsEntry.data);
        useSettingsStore.setState(settings);
        restored.settings = true;
      } catch (err) {
        warnings.push(`Failed to restore settings: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Restore style profiles ──────────────────────────────────────────
  if (shouldRestore('includeStyleProfiles')) {
    const profilesEntry = entryMap.get('style-profiles.json');
    if (profilesEntry) {
      try {
        const incomingProfiles = decodeJSON<StyleProfile[]>(profilesEntry.data);

        if (options.mode === 'replace') {
          useStyleProfileStore.setState({ profiles: incomingProfiles });
          restored.styleProfiles = incomingProfiles.length;
        } else {
          // Merge mode: handle conflicts per-profile
          const existingProfiles = useStyleProfileStore.getState().profiles;
          const existingById = new Map(existingProfiles.map((p) => [p.id, p]));
          const merged = [...existingProfiles];

          for (const incoming of incomingProfiles) {
            const conflictId = `profile:${incoming.id}`;
            const resolution = options.conflictResolutions[conflictId];
            const existing = existingById.get(incoming.id);

            if (!existing) {
              merged.push(incoming);
              restored.styleProfiles++;
            } else if (resolution === 'replace') {
              const idx = merged.findIndex((p) => p.id === incoming.id);
              if (idx >= 0) {
                merged[idx] = incoming;
              }
              restored.styleProfiles++;
            } else if (resolution === 'keep-both') {
              const copy = { ...incoming, id: `${incoming.id}-restored`, name: `${incoming.name} (restored)` };
              merged.push(copy);
              restored.styleProfiles++;
            }
            // 'keep-existing' or default: skip
          }

          useStyleProfileStore.setState({ profiles: merged });
        }
      } catch (err) {
        warnings.push(`Failed to restore style profiles: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Restore color palette ───────────────────────────────────────────
  if (shouldRestore('includeColorPalette')) {
    const paletteEntry = entryMap.get('color-palette.json');
    if (paletteEntry) {
      try {
        const palette = decodeJSON<{ recentColors: string[]; customColor: string }>(paletteEntry.data);
        useColorPaletteStore.setState(palette);
        restored.colorPalette = true;
      } catch (err) {
        warnings.push(`Failed to restore color palette: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Restore icon library ────────────────────────────────────────────
  if (shouldRestore('includeIconLibrary')) {
    const iconEntry = entryMap.get('icon-library.json');
    if (iconEntry) {
      try {
        const customIcons = decodeJSON<unknown[]>(iconEntry.data);
        useIconLibraryStore.setState((state) => ({ ...state, customIcons: customIcons as typeof state.customIcons }));
        restored.iconLibrary = true;
      } catch (err) {
        warnings.push(`Failed to restore icon library: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Restore shape libraries ─────────────────────────────────────────
  if (shouldRestore('includeShapeLibraries')) {
    const librariesEntry = entryMap.get('custom-shape-libraries.json');
    if (librariesEntry) {
      try {
        const incomingLibs = decodeJSON<CustomShapeLibrary[]>(librariesEntry.data);

        if (options.mode === 'replace') {
          useCustomShapeLibraryStore.setState({ libraries: incomingLibs });
          restored.shapeLibraries = incomingLibs.length;
        } else {
          // Merge
          const existingLibs = useCustomShapeLibraryStore.getState().libraries;
          const existingById = new Map(existingLibs.map((l) => [l.id, l]));
          const merged = [...existingLibs];

          for (const incoming of incomingLibs) {
            const conflictId = `library:${incoming.id}`;
            const resolution = options.conflictResolutions[conflictId];
            const existing = existingById.get(incoming.id);

            if (!existing) {
              merged.push(incoming);
              restored.shapeLibraries++;
            } else if (resolution === 'replace') {
              const idx = merged.findIndex((l) => l.id === incoming.id);
              if (idx >= 0) {
                merged[idx] = incoming;
              }
              restored.shapeLibraries++;
            } else if (resolution === 'keep-both') {
              const copy = { ...incoming, id: `${incoming.id}-restored`, name: `${incoming.name} (restored)` };
              merged.push(copy);
              restored.shapeLibraries++;
            }
          }

          useCustomShapeLibraryStore.setState({ libraries: merged });
        }
      } catch (err) {
        warnings.push(`Failed to restore shape libraries: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Restore UI preferences ──────────────────────────────────────────
  if (shouldRestore('includeUiPreferences')) {
    const prefsEntry = entryMap.get('ui-preferences.json');
    if (prefsEntry) {
      try {
        const prefs = decodeJSON<Record<string, unknown>>(prefsEntry.data);
        useUIPreferencesStore.setState(prefs);
        restored.uiPreferences = true;
      } catch (err) {
        warnings.push(`Failed to restore UI preferences: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Restore icon presets ────────────────────────────────────────────
  if (shouldRestore('includeIconPresets')) {
    const presetsEntry = entryMap.get('icon-presets.json');
    if (presetsEntry) {
      try {
        const presets = decodeJSON<unknown[]>(presetsEntry.data);
        useIconPresetStore.setState((state) => ({ ...state, customPresets: presets as typeof state.customPresets }));
        restored.iconPresets = true;
      } catch (err) {
        warnings.push(`Failed to restore icon presets: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  progress({ phase: 'done', current: 1, total: 1 });

  return {
    success: true,
    restored,
    warnings,
    durationMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Replace mode: wipe existing data
// ---------------------------------------------------------------------------

async function wipeExistingData(
  shouldRestore: (cat: string) => boolean
): Promise<void> {
  if (shouldRestore('includeDocuments')) {
    const docs = usePersistenceStore.getState().documents;
    for (const docId of Object.keys(docs)) {
      deleteDocumentFromStorage(docId);
    }
    usePersistenceStore.setState({ documents: {} });
  }

  if (shouldRestore('includeBlobs')) {
    const allBlobs = await blobStorage.listAllBlobs();
    for (const blob of allBlobs) {
      await blobStorage.deleteBlob(blob.id);
    }
  }

  if (shouldRestore('includeStyleProfiles')) {
    useStyleProfileStore.getState().clearProfiles();
  }

  if (shouldRestore('includeColorPalette')) {
    useColorPaletteStore.getState().reset();
  }

  if (shouldRestore('includeShapeLibraries')) {
    const { libraries } = useCustomShapeLibraryStore.getState();
    for (const lib of libraries) {
      await useCustomShapeLibraryStore.getState().deleteLibrary(lib.id);
    }
  }
}
